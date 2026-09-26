const db = require('../config/db');
const crypto = require('crypto');

const MIN_STAKE = 20;
const MAX_STAKE = 10000;
const MAX_WIN = 10000;
const VOID_WINDOW_MINUTES = 20;
const MATCH_START_BUFFER_MS = 60 * 1000;

const asText = value => String(value ?? '').trim();

// ==============================================================================
// 🌟 1. የ Frontend-ን ፎርሙላ የሚጠቀም ማርኬት አጣሪ (Perfected Ticket Placement)
// ==============================================================================

const extractRawMarkets = (oddsData) => {
    const parsed = typeof oddsData === 'string' ? JSON.parse(oddsData) : oddsData;
    const bookmakers = Array.isArray(parsed) ? parsed : [parsed];
    if (bookmakers && bookmakers[0]) {
        return bookmakers[0].bets || bookmakers[0].markets || [];
    }
    return [];
};

const sanitizeIdPart = (s) => String(s ?? '').trim().replace(/[^a-zA-Z0-9+\-.]/g, '_');

const getMarketKind = (mkt) => {
    const idNum = Number(mkt?.id);
    const key = mkt?.key;
    const title = String(mkt?.name || mkt?.title || '').toLowerCase();
    if (idNum === 1 || idNum === 13 || key === 'h2h' || ['match winner', '3 way', 'full time result', 'first half winner'].includes(title)) return 'h2h';
    if (idNum === 12 || key === 'double_chance' || title.includes('double chance')) return 'dc';
    return 'other';
};

const standardizeOptionLabel = (kind, rawLabel, matchInfo) => {
    const label = String(rawLabel ?? '').trim();
    if (kind === 'h2h') {
        if (label === matchInfo?.home_team || label === 'Home' || label === '1') return '1';
        if (label === 'Draw' || label === 'X') return 'X';
        if (label === matchInfo?.away_team || label === 'Away' || label === '2') return '2';
        return label;
    }
    if (kind === 'dc') {
        if (['1X', '12', 'X2'].includes(label)) return label;
        if (label.includes('Home') && label.includes('Draw')) return '1X';
        if (label.includes('Home') && label.includes('Away')) return '12';
        if (label.includes('Draw') && label.includes('Away')) return 'X2';
        return label;
    }
    return label;
};

const buildOddId = (marketRef, optionLabel, gameId) =>
    `${sanitizeIdPart(marketRef)}_${sanitizeIdPart(optionLabel)}_${gameId}`;

const resolveCanonicalSelection = (matchInfo, item) => {
    const rawMarkets = extractRawMarkets(matchInfo.odds_data);
    const targetOddId = String(item.odd_id);
    
    let bestCandidate = null;

    for (const bet of rawMarkets) {
        const outcomesArray = bet.values || bet.outcomes || [];
        if (!outcomesArray || outcomesArray.length === 0) continue;

        const rawTitle = String(bet.title || bet.name || "Market").trim();
        
        let betId = Number(bet.id);
        if (!betId && bet.key) {
            if (bet.key === 'h2h') betId = 1;
            else if (bet.key === 'double_chance') betId = 12;
            else if (bet.key === 'totals') betId = 5;
            else if (bet.key === 'btts') betId = 8;
            else {
                const match = String(bet.key).match(/\d+/);
                if (match) betId = parseInt(match[0], 10);
            }
        }

        const marketKind = getMarketKind(bet);
        const marketRef = bet.key || betId || rawTitle;

        for (const outcome of outcomesArray) {
            const rawLabel = outcome.name || outcome.value || outcome.label;
            const standardOpt = standardizeOptionLabel(marketKind, rawLabel, matchInfo);
            const generatedOddId = buildOddId(marketRef, standardOpt, matchInfo.id);

            if (generatedOddId === targetOddId) {
                bestCandidate = { market: bet, outcome: outcome };
                break;
            }
        }
        if (bestCandidate) break;
    }

    if (!bestCandidate) {
        return null; 
    }

    const { market, outcome } = bestCandidate;

    return {
        fixture_id: item.fixture_id,
        odd_id: item.odd_id,
        odd_value: Number(outcome.price || outcome.odd).toFixed(2), 
        odd_name: asText(item.odd_name), 
        market_id: String(market.id || ''),
        market_key: String(market.key || market.name || ''),
        market_name: asText(item.market_name || "Match Market"), 
        league_name: item.league_name || matchInfo.league_name || matchInfo.league || null,
        sport_key: item.sport_key || item.sport || matchInfo.sport_key || null,
        match_info: item.match_info || `${matchInfo.home_team} vs ${matchInfo.away_team}`
    };
};

const getTicketItems = async (connection, ticketId) => {
    const [items] = await connection.query(
        `SELECT ti.*, sm.commence_time
         FROM ticket_items ti
         LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id
         WHERE ti.ticket_id = ?`,
        [ticketId]
    );
    return items;
};

const calculateTicketResult = (ticket, items) => {
    let lastMatchTime = new Date(ticket.created_at).getTime();
    let isLost = false;
    let isPending = false;
    let calculatedOdds = 1;

    for (const item of items) {
        const matchTime = new Date(
            item.commence_time || ticket.created_at
        ).getTime();

        if (matchTime > lastMatchTime) lastMatchTime = matchTime;

        if (item.match_status === 'lost') {
            isLost = true;
        } else if (item.match_status === 'won') {
            calculatedOdds *= Number(item.odd_value);
        } else if (
            item.match_status === 'postponed' ||
            item.match_status === 'cancelled' ||
            item.match_status === 'abandoned'
        ) {
            calculatedOdds *= 1;
        } else {
            isPending = true;
        }
    }

    let status = 'won';
    if (isLost) status = 'lost';
    else if (isPending) status = 'pending';

    const potentialWin = Number(
        (calculatedOdds * Number(ticket.stake_amount)).toFixed(2)
    );

    return {
        status,
        potentialWin,
        lastMatchTime
    };
};

// ==============================================================================
// 🌟 2. ትኬት መቁረጥ እና ማስተዳደር (Ticket Functions)
// ==============================================================================

const placeTicket = async (req, res) => {
    let connection;
    let transactionStarted = false;
    try {
        const { stake_amount, is_guest, selections } = req.body;
        const isGuestBooking = is_guest === true || is_guest === 'true';

        if (!isGuestBooking && !req.user?.id) {
            return res.status(401).json({ success: false, message: 'ይህን ትኬት ለመቁረጥ መግባት ያስፈልጋል' });
        }
        
        const stake = parseFloat(stake_amount);
        if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
            return res.status(400).json({ success: false, message: 'የተሳሳተ የገንዘብ መጠን (Stake)!' });
        }

        if (!Array.isArray(selections) || selections.length === 0) {
            return res.status(400).json({ success: false, message: 'ምንም አይነት ጨዋታ አልተመረጠም!' });
        }

        const uniqueFixtures = new Set(selections.map(s => String(s.fixture_id)));
        if (uniqueFixtures.size !== selections.length) {
            return res.status(400).json({ success: false, message: 'ከአንድ ጨዋታ ከአንድ በላይ ምርጫ ማካተት አይቻልም!' });
        }

        connection = await db.getConnection();

        const fixtureIds = selections.map(s => s.fixture_id);
        const [matches] = await connection.query('SELECT id, commence_time, odds_data, sport_key, home_team, away_team FROM saved_matches WHERE id IN (?)', [fixtureIds]);

        let calculatedTotalOdds = 1;
        for (let item of selections) {
            const matchInfo = matches.find(m => m.id == item.fixture_id);
            
            if (!matchInfo) {
                return res.status(400).json({ success: false, message: 'አንዳንድ ጨዋታዎች በሲስተሙ ውስጥ አልተገኙም!' });
            }

            if (new Date(matchInfo.commence_time).getTime() - MATCH_START_BUFFER_MS < Date.now()) {
                return res.status(400).json({ success: false, message: 'ጨዋታው ሊጀምር ስለሆነ ወይም ስላለፈ መቁረጥ አይቻልም!' });
            }

            const canonicalSelection = resolveCanonicalSelection(matchInfo, item);
            if (!canonicalSelection) {
                return res.status(400).json({ success: false, message: `የተሳሳተ market ወይም odds ተልኳል! (${item.match_info})` });
            }

            item._canonical = canonicalSelection;
            calculatedTotalOdds *= Number(canonicalSelection.odd_value);
        }

        calculatedTotalOdds = Math.round(calculatedTotalOdds * 100) / 100;
        let calculatedPotentialWin = Math.round((calculatedTotalOdds * stake) * 100) / 100;
        
        if (calculatedPotentialWin > MAX_WIN) {
            return res.status(400).json({ success: false, message: `ከፍተኛው ማሸነፊያ ${MAX_WIN} ብር ብቻ ነው!` });
        }

        let userId = null;
        if (!isGuestBooking && req.user) userId = req.user.id;

        const ticketNumber = isGuestBooking ? null : crypto.randomInt(10000000, 99999999).toString();
        const bookingCode = isGuestBooking ? crypto.randomInt(100000, 999999).toString() : null;
        const status = isGuestBooking ? 'pending' : 'active';

        await connection.beginTransaction();
        transactionStarted = true;

        const [ticketResult] = await connection.query(
            'INSERT INTO tickets (user_id, ticket_number, booking_code, stake_amount, total_odds, potential_win, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, ticketNumber, bookingCode, stake, calculatedTotalOdds.toFixed(2), calculatedPotentialWin.toFixed(2), status]
        );

        for (let item of selections) {
            const selection = item._canonical;
            await connection.query(
                `INSERT INTO ticket_items (ticket_id, fixture_id, odd_id, market_id, market_key, market_name, league_name, sport_key, odd_value, match_info, odd_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [ticketResult.insertId, selection.fixture_id, selection.odd_id, selection.market_id, selection.market_key, selection.market_name, selection.league_name, selection.sport_key, selection.odd_value, selection.match_info, selection.odd_name]
            );
        }

        await connection.commit();
        res.json({ success: true, data: { ticket_number: ticketNumber, booking_code: bookingCode } });
    } catch (error) {
        if (connection && transactionStarted) await connection.rollback();
        console.error("❌ Place Ticket DB Error:", error);
        res.status(500).json({ success: false, message: 'ትኬት መቁረጥ አልተቻለም' });
    } finally {
        if (connection) connection.release();
    }
};

const getBooking = async (req, res) => {
    try {
        const [tickets] = await db.query('SELECT * FROM tickets WHERE booking_code = ?', [req.params.code.trim()]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ይህ ቡኪንግ ኮድ አልተገኘም!' });
        const [items] = await db.query('SELECT ti.*, sm.commence_time FROM ticket_items ti LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id WHERE ti.ticket_id = ?', [tickets[0].id]);
        res.json({ success: true, data: { ...tickets[0], selections: items } });
    } catch (error) { res.status(500).json({ success: false }); }
};

const confirmBooking = async (req, res) => {
    let connection;
    try {
        if (!req.user?.id) {
            return res.status(401).json({ success: false, message: 'ይህን ትኬት ለማረጋገጥ የካሼር መግቢያ ያስፈልጋል' });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [tickets] = await connection.query('SELECT * FROM tickets WHERE booking_code = ? FOR UPDATE', [req.params.code.trim()]);
        if (tickets.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'ቡኪንግ ኮድ አልተገኘም' });
        }
        
        const ticket = tickets[0];

        if (ticket.ticket_number && ticket.status !== 'void') {
            const items = await getTicketItems(connection, ticket.id);
            await connection.rollback();
            return res.json({ success: true, data: { ...ticket, selections: items } });
        }

        if (ticket.status !== 'pending') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ይህ ትኬት አስቀድሞ ተቆርጧል ወይም ተሰርዟል!' });
        }

        const [items] = await connection.query('SELECT fixture_id FROM ticket_items WHERE ticket_id = ?', [ticket.id]);
        const fixtureIds = items.map(i => i.fixture_id);
        
        if (fixtureIds.length > 0) {
            const [matches] = await connection.query('SELECT id, commence_time FROM saved_matches WHERE id IN (?)', [fixtureIds]);
            for (let match of matches) {
                if (new Date(match.commence_time).getTime() - MATCH_START_BUFFER_MS < Date.now()) {
                    await connection.rollback();
                    return res.status(400).json({ success: false, message: 'በትኬቱ ውስጥ የጀመሩ ጨዋታዎች ስላሉ ማረጋገጥ አይቻልም! እባክዎ አዲስ ይቁረጡ።' });
                }
            }
        }
        
        const ticketNumber = crypto.randomInt(10000000, 99999999).toString();
        await connection.query('UPDATE tickets SET ticket_number = ?, status = ?, user_id = ? WHERE id = ?', [ticketNumber, 'active', req.user.id, ticket.id]);

        const finalItems = await getTicketItems(connection, ticket.id);
        const confirmedTicket = {
            ...ticket,
            ticket_number: ticketNumber,
            status: 'active',
            user_id: req.user.id,
            selections: finalItems
        };

        await connection.commit();
        res.json({ success: true, data: confirmedTicket });
    } catch (error) { 
        if (connection) await connection.rollback();
        console.error('Confirm booking error:', error);
        res.status(500).json({ success: false, message: 'ትኬቱን ማረጋገጥ አልተቻለም' }); 
    } finally {
        if (connection) connection.release();
    }
};

const checkTicket = async (req, res) => {
    try {
        const code = req.params.code.trim(); 
        const [tickets] = await db.query('SELECT * FROM tickets WHERE ticket_number = ? OR booking_code = ?', [code, code]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ይህ ትኬት አልተገኘም! ቁጥሩን በትክክል ያስገቡ።' });

        let ticket = tickets[0];
        const items = await getTicketItems(db, ticket.id);

        if (ticket.status === 'active' || ticket.status === 'pending') {
            const result = calculateTicketResult(ticket, items);
            ticket.status = result.status;

            if (result.status === 'won') {
                ticket.potential_win = result.potentialWin.toFixed(2);
            }

            if (result.status !== tickets[0].status || result.status === 'won') {
                await db.query(
                    `UPDATE tickets SET status = ?, potential_win = ? WHERE id = ? AND status NOT IN ('paid', 'void', 'expired')`,
                    [result.status, result.potentialWin.toFixed(2), ticket.id]
                );
            }
        }

        res.json({ success: true, data: { ...ticket, selections: items } });
    } catch (error) { res.status(500).json({ success: false, message: 'ስህተት ተፈጥሯል' }); }
};

const loadTicket = async (req, res) => {
    try {
        const [tickets] = await db.query('SELECT * FROM tickets WHERE booking_code = ?', [req.params.code.trim()]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ይህ ቡኪንግ ኮድ አልተገኘም!' });
        const [items] = await db.query('SELECT * FROM ticket_items WHERE ticket_id = ?', [tickets[0].id]);
        res.json({ success: true, data: { stake_amount: tickets[0].stake_amount, selections: items } });
    } catch (error) { res.status(500).json({ success: false }); }
};

const payoutTicket = async (req, res) => {
    let connection;
    try {
        const ticketNumber = req.body.ticket_number ? String(req.body.ticket_number).trim() : '';
        if (!ticketNumber) {
            return res.status(400).json({ success: false, message: 'የትኬት ቁጥር አልተላከም' });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [tickets] = await connection.query(
            'SELECT * FROM tickets WHERE ticket_number = ? OR booking_code = ? FOR UPDATE',
            [ticketNumber, ticketNumber]
        );
        
        if (tickets.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'ትኬቱ አልተገኘም' });
        }

        const ticket = tickets[0];
        
        if (ticket.status === 'paid') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ይህ ትኬት አስቀድሞ ተከፍሎታል!' });
        }

        if (ticket.status === 'void') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ይህ ትኬት የተሰረዘ (Void) ነው!' });
        }

        const items = await getTicketItems(connection, ticket.id);
        const result = calculateTicketResult(ticket, items);

        if (Date.now() > result.lastMatchTime + (3 * 24 * 60 * 60 * 1000)) {
            await connection.query(
                "UPDATE tickets SET status = 'expired' WHERE id = ? AND status NOT IN ('paid', 'void')",
                [ticket.id]
            );
            await connection.commit();
            return res.status(400).json({ success: false, message: 'የዚህ ትኬት መክፈያ ጊዜ (3 ቀን) አልፏል! ክፍያው ውድቅ ሆኗል።' });
        }

        if (result.status === 'lost' || ticket.status === 'lost') {
            await connection.query(
                "UPDATE tickets SET status = 'lost' WHERE id = ? AND status NOT IN ('paid', 'void', 'expired')",
                [ticket.id]
            );
            await connection.commit();
            return res.status(400).json({ success: false, message: 'ይህ ትኬት አላሸነፈም (ተሸንፏል)!' });
        }

        if (result.status === 'pending') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ትኬቱ አሁንም ውጤት እየጠበቀ (Pending) ነው! ሁሉም ጨዋታዎች አላለቁም።' });
        }

        const finalWinAmount = result.potentialWin.toFixed(2);

        const [updateResult] = await connection.query(
            "UPDATE tickets SET status = 'paid', potential_win = ? WHERE id = ? AND status NOT IN ('paid', 'void', 'expired')", 
            [finalWinAmount, ticket.id]
        );

        if (updateResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ክፍያው አስቀድሞ ተፈጽሟል!' });
        }

        await connection.commit();
        res.json({
            success: true,
            message: 'ክፍያው በተሳካ ሁኔታ ተፈጽሟል',
            payout_amount: finalWinAmount,
            payout_data: { amount_paid: finalWinAmount }
        });

    } catch (error) { 
        if (connection) await connection.rollback();
        console.error("Payout Error: ", error);
        res.status(500).json({ success: false, message: 'ክፍያ መፈጸም አልተቻለም (Server Error)' }); 
    } finally {
        if (connection) connection.release();
    }
};

const voidTicket = async (req, res) => {
    try {
        const requestedTicketNumber = asText(req.body.ticket_number);
        if (!requestedTicketNumber) {
            return res.status(400).json({ success: false, message: 'የትኬት ቁጥር አልተላከም' });
        }

        const [tickets] = await db.query(
            'SELECT id, user_id, status, created_at FROM tickets WHERE ticket_number = ?',
            [requestedTicketNumber]
        );
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ትኬቱ አልተገኘም' });

        const ticket = tickets[0];
        if (ticket.status !== 'active') return res.status(400).json({ success: false, message: 'ትኬቱ አክቲቭ አይደለም (መሰረዝ አይቻልም)' });
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'የካሼር መግቢያ ያስፈልጋል' });
        }
        if (ticket.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'መሰረዝ የሚችለው የቆረጠው ካሼር ብቻ ነው' });
        }

        const [timeCheck] = await db.query('SELECT TIMESTAMPDIFF(MINUTE, created_at, NOW()) as diff FROM tickets WHERE id = ?', [ticket.id]);
        if (timeCheck[0].diff >= VOID_WINDOW_MINUTES) {
            return res.status(400).json({
                success: false,
                message: `ትኬቱን መሰረዝ የሚቻለው ከተቆረጠ በ ${VOID_WINDOW_MINUTES} ደቂቃ ውስጥ ብቻ ነው!`
            });
        }

        await db.query("UPDATE tickets SET status = 'void' WHERE id = ?", [ticket.id]);
        res.json({ success: true, message: 'ትኬቱ በተሳካ ሁኔታ ተሰርዟል (Voided)' });
    } catch (error) { res.status(500).json({ success: false, message: 'ትኬቱን መሰረዝ አልተቻለም' }); }
};

// ==============================================================================
// 🌟 3. የአድሚን እና የካሼር ሪፖርቶች (Reports & Admin Functions) 🌟
// ==============================================================================

// 🚨 የ Error መፍትሄ፡ ራውተሩ የሚፈልገው ስም "getTicketHistory" ነው
const getTicketHistory = async (req, res) => {
    try {
        const [tickets] = await db.query("SELECT ticket_number, stake_amount, potential_win, status, created_at FROM tickets WHERE user_id = ? AND status != 'pending' ORDER BY created_at DESC LIMIT 20", [req.user.id]);
        res.json({ success: true, data: tickets });
    } catch (error) { res.status(500).json({ success: false }); }
};

const getCashierReport = async (req, res) => {
    const { filter } = req.query; 
    let dateCondition = "DATE(created_at) = CURDATE()"; 
    if (filter === 'week') dateCondition = "YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)";
    else if (filter === 'month') dateCondition = "MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())";
    else if (filter === 'year') dateCondition = "YEAR(created_at) = YEAR(CURDATE())";

    try {
        const [stats] = await db.query(`
            SELECT COUNT(id) as total_tickets, SUM(stake_amount) as total_revenue,
            SUM(CASE WHEN status = 'paid' THEN potential_win ELSE 0 END) as total_paid,
            SUM(CASE WHEN status = 'won' THEN potential_win ELSE 0 END) as unpaid_winnings
            FROM tickets WHERE user_id = ? AND status != 'pending' AND status != 'void' AND ${dateCondition}
        `, [req.user.id]);

        const data = stats[0];
        res.json({ 
            success: true, 
            data: {
                total_tickets: data.total_tickets || 0,
                total_revenue: data.total_revenue || 0,
                total_paid: data.total_paid || 0,
                unpaid_winnings: data.unpaid_winnings || 0,
                net_profit: (data.total_revenue || 0) - (data.total_paid || 0)
            } 
        });
    } catch (error) { res.status(500).json({ success: false }); }
};

const getSummaryReport = async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false });
    const { filter } = req.query; 
    let dateCondition = "DATE(t.created_at) = CURDATE()"; 
    if (filter === 'month') dateCondition = "MONTH(t.created_at) = MONTH(CURDATE()) AND YEAR(t.created_at) = YEAR(CURDATE())";
    else if (filter === 'year') dateCondition = "YEAR(t.created_at) = YEAR(CURDATE())";

    try {
        const [overall] = await db.query(`SELECT COUNT(id) as total_tickets, SUM(stake_amount) as total_revenue, SUM(CASE WHEN status = 'won' THEN potential_win ELSE 0 END) as total_payout FROM tickets t WHERE ${dateCondition} AND status != 'pending' AND status != 'void'`);
        const [cashierStats] = await db.query(`SELECT u.username as cashier, COUNT(t.id) as tickets_sold, SUM(CASE WHEN t.status = 'won' THEN 1 ELSE 0 END) as winning_tickets_count, SUM(t.stake_amount) as revenue, SUM(CASE WHEN t.status = 'won' THEN t.potential_win ELSE 0 END) as payout FROM tickets t JOIN users u ON t.user_id = u.id WHERE ${dateCondition} AND t.status != 'pending' AND t.status != 'void' AND u.role = 'cashier' GROUP BY u.username ORDER BY revenue DESC`);
        const [onlineStatsRow] = await db.query(`SELECT COUNT(t.id) as tickets_sold, SUM(CASE WHEN t.status = 'won' THEN 1 ELSE 0 END) as winning_tickets_count, SUM(t.stake_amount) as revenue, SUM(CASE WHEN t.status = 'won' THEN t.potential_win ELSE 0 END) as payout FROM tickets t JOIN users u ON t.user_id = u.id WHERE ${dateCondition} AND t.status != 'pending' AND t.status != 'void' AND u.role = 'user'`);
        const [onlineUsersCount] = await db.query("SELECT COUNT(id) as count FROM users WHERE role = 'user'");
        const [winningTickets] = await db.query(`SELECT t.ticket_number, u.username as cashier, u.role, t.stake_amount, t.potential_win, t.status, t.created_at FROM tickets t LEFT JOIN users u ON t.user_id = u.id WHERE (t.status = 'won' OR t.status = 'expired' OR t.status = 'paid') AND ${dateCondition} ORDER BY t.created_at DESC LIMIT 100`);
        
        res.json({ success: true, data: { 
            totalTickets: overall[0].total_tickets || 0, 
            totalRevenue: overall[0].total_revenue || 0, 
            totalPayout: overall[0].total_payout || 0, 
            activeOnlineUsers: onlineUsersCount[0].count || 0, 
            onlineStats: onlineStatsRow[0] || { tickets_sold: 0, winning_tickets_count: 0, revenue: 0, payout: 0 }, 
            cashierStats: cashierStats, 
            winningTickets: winningTickets 
        }});
    } catch (error) { res.status(500).json({ success: false }); }
};

const getStaffList = async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false });
    try {
        const [staff] = await db.query("SELECT id, username, role, created_at FROM users WHERE role = 'cashier' ORDER BY created_at DESC");
        res.json({ success: true, data: staff });
    } catch (error) { res.status(500).json({ success: false }); }
};

const getAllTickets = async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'ያልተፈቀደ (Unauthorized)' });
    
    try {
        const [tickets] = await db.query(`
            SELECT t.*, u.username as cashier, u.role 
            FROM tickets t 
            LEFT JOIN users u ON t.user_id = u.id 
            ORDER BY t.created_at DESC
            LIMIT 200
        `);
        
        const [selections] = await db.query('SELECT * FROM ticket_items');

        const formattedTickets = tickets.map(ticket => ({
            ...ticket,
            selections: selections.filter(s => s.ticket_id === ticket.id)
        }));

        res.json({ success: true, data: formattedTickets });
    } catch (error) {
        console.error('Error fetching all tickets:', error);
        res.status(500).json({ success: false, message: 'ትኬቶችን ማምጣት አልተቻለም!' });
    }
};

// 🌟 የፈንክሽኖች መላኪያ (Export) - ማንም ራውተር እንዳይቋረጥ በጥንቃቄ የተሰራ
module.exports = {
    placeTicket, getBooking, confirmBooking, checkTicket, loadTicket, payoutTicket, voidTicket,
    
    // ራውተር የሚጠይቃቸው ስሞች እንዳይሳሳቱ Alias ተሰጥቷቸዋል
    getTicketHistory, getHistory: getTicketHistory, history: getTicketHistory,
    getCashierReport, report: getCashierReport, cashierReport: getCashierReport,
    getSummaryReport, getStaffList, getAllTickets 
};