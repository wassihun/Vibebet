const db = require('../config/db');
const crypto = require('crypto');
const axios = require('axios');

const MIN_STAKE = 20;
const MAX_STAKE = 10000;
const MAX_WIN = 10000;
const VOID_WINDOW_MINUTES = 20;
const MATCH_START_BUFFER_MS = 60 * 1000;

const asText = value => String(value ?? '').trim();

// ==============================================================================
// 🌟 1. የ Frontend-ን ፎርሙላ የሚጠቀም ማርኬት አጣሪ እና የትኬት ቁጥር አመንጪ
// ==============================================================================

const generateUniqueTicketNumber = async (connection) => {
    for (let i = 0; i < 10; i++) {
        const candidate = crypto.randomInt(10000000, 99999999).toString();
        const [rows] = await connection.query('SELECT id FROM tickets WHERE ticket_number = ? LIMIT 1', [candidate]);
        if (!rows || rows.length === 0) return candidate;
    }
    return `${Date.now().toString().slice(-6)}${crypto.randomInt(10, 99)}`;
};

const generateUniqueBookingCode = async (connection) => {
    for (let i = 0; i < 10; i++) {
        const candidate = crypto.randomInt(100000, 999999).toString();
        const [rows] = await connection.query('SELECT id FROM tickets WHERE booking_code = ? LIMIT 1', [candidate]);
        if (!rows || rows.length === 0) return candidate;
    }
    return crypto.randomInt(100000, 999999).toString();
};

const extractRawMarkets = (oddsData) => {
    try {
        if (!oddsData) return [];
        const parsed = typeof oddsData === 'string' ? JSON.parse(oddsData) : oddsData;
        const bookmakers = Array.isArray(parsed) ? parsed : [parsed];
        if (bookmakers && bookmakers[0]) {
            return bookmakers[0].bets || bookmakers[0].markets || [];
        }
    } catch (e) {}
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
                bestCandidate = { market: bet, outcome: outcome, resolvedBetId: betId };
                break;
            }
        }
        if (bestCandidate) break;
    }

    if (!bestCandidate) {
        return null; 
    }

    const { market, outcome, resolvedBetId } = bestCandidate;

    return {
        fixture_id: item.fixture_id,
        odd_id: item.odd_id,
        odd_value: Number(outcome.price || outcome.odd).toFixed(2), 
        odd_name: asText(item.odd_name), 
        market_id: String(market.id || resolvedBetId || ''),
        market_key: String(market.key || market.name || ''),
        market_name: asText(item.market_name || market.name || market.title || "Match Market"), 
        league_name: item.league_name || matchInfo.league_name || matchInfo.league || null,
        sport_key: item.sport_key || item.sport || matchInfo.sport_key || null,
        match_info: item.match_info || `${matchInfo.home_team} vs ${matchInfo.away_team}`
    };
};

// ⚡ የፍጥነት ማሻሻያ፡ ግዙፉን sm.odds_data JSON አላስፈላጊ በሆነ ጊዜ እንዳይጭን ተደርጓል
const getTicketItems = async (connection, ticketId) => {
    const [items] = await connection.query(
        `SELECT ti.*, sm.commence_time, sm.home_team, sm.away_team
         FROM ticket_items ti
         LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id
         WHERE ti.ticket_id = ?`,
        [ticketId]
    );

    const missingMarketItems = items.filter(
        item => !item.market_id || !item.market_name || item.market_name === 'Match Market' || item.market_name === 'Market'
    );

    if (missingMarketItems.length > 0) {
        const fixtureIds = [...new Set(missingMarketItems.map(i => i.fixture_id).filter(Boolean))];
        if (fixtureIds.length > 0) {
            const [oddsRows] = await connection.query(
                `SELECT id, odds_data FROM saved_matches WHERE id IN (?)`,
                [fixtureIds]
            );
            const oddsMap = new Map(oddsRows.map(r => [String(r.id), r.odds_data]));

            for (const item of missingMarketItems) {
                const oddsData = oddsMap.get(String(item.fixture_id));
                if (oddsData) {
                    const resolved = resolveCanonicalSelection(
                        { id: item.fixture_id, home_team: item.home_team, away_team: item.away_team, odds_data: oddsData },
                        item
                    );
                    if (resolved) {
                        if (!item.market_id && resolved.market_id) item.market_id = resolved.market_id;
                        if (!item.market_key && resolved.market_key) item.market_key = resolved.market_key;
                        if ((!item.market_name || item.market_name === 'Match Market' || item.market_name === 'Market') && resolved.market_name) {
                            item.market_name = resolved.market_name;
                        }
                    }
                }
            }
        }
    }

    return items;
};

// 🌟 የተስተካከለው የትኬት ውጤት እና Potential Win ስሌት (ትኬቱ Pending/Lost ሲሆን ወደ Stake እንዳይመለስ የሚጠብቅ) 🌟
const calculateTicketResult = (ticket, items) => {
    let lastMatchTime = new Date(ticket.created_at).getTime();
    let isLost = false;
    let isPending = false;
    let wonOdds = 1;
    let activeOdds = 1;

    for (const item of items) {
        const matchTime = new Date(
            item.commence_time || item.match_time || ticket.created_at
        ).getTime();

        if (!Number.isNaN(matchTime) && matchTime > lastMatchTime) {
            lastMatchTime = matchTime;
        }

        const oddVal = parseFloat(item.odd_value);
        const validOdd = Number.isFinite(oddVal) && oddVal > 0 ? oddVal : 1;
        const st = String(item.match_status || 'pending').toLowerCase();

        if (st === 'lost') {
            isLost = true;
            activeOdds *= validOdd;
        } else if (st === 'won') {
            wonOdds *= validOdd;
            activeOdds *= validOdd;
        } else if (
            st === 'postponed' ||
            st === 'cancelled' ||
            st === 'abandoned'
        ) {
            wonOdds *= 1;
            activeOdds *= 1;
        } else {
            isPending = true;
            activeOdds *= validOdd;
        }
    }

    let status = 'won';
    if (isLost) status = 'lost';
    else if (isPending) status = 'pending';

    const stake = parseFloat(ticket.stake_amount) || 0;
    const effectiveOdds = status === 'won' ? wonOdds : activeOdds;
    let potentialWin = Number((effectiveOdds * stake).toFixed(2));

    // በዳታቤዝ ላይ ከዚህ በፊት የተቀመጠ ትክክለኛ potential_win ካለ እና items ባዶ ከሆኑ እሱን መጠበቅ
    const storedWin = parseFloat(ticket.potential_win) || 0;
    if ((!items || items.length === 0) && storedWin > stake) {
        potentialWin = storedWin;
    }

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

        let userId = null;
        let isOnlineUser = false;
        if (!isGuestBooking && req.user) {
            userId = req.user.id;
            if (req.user.role === 'user') isOnlineUser = true;
        }

        if (!isGuestBooking && !userId) {
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
        const [matches] = await connection.query(
            'SELECT id, commence_time, odds_data, sport_key, home_team, away_team FROM saved_matches WHERE id IN (?)',
            [fixtureIds]
        );

        let calculatedTotalOdds = 1;
        for (let item of selections) {
            const matchInfo = matches.find(m => String(m.id) === String(item.fixture_id));
            
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

        await connection.beginTransaction();
        transactionStarted = true;

        const ticketNumber = isGuestBooking ? null : await generateUniqueTicketNumber(connection);
        const bookingCode = isGuestBooking ? await generateUniqueBookingCode(connection) : null;
        const status = isGuestBooking ? 'pending' : 'active';

        if (isOnlineUser) {
            const [users] = await connection.query('SELECT current_balance FROM users WHERE id = ? FOR UPDATE', [userId]);
            if (users.length === 0 || Number(users[0].current_balance) < stake) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'በቂ ባላንስ የሎትም! እባክዎ ዲፖዚት ያድርጉ።' });
            }
            await connection.query('UPDATE users SET current_balance = current_balance - ? WHERE id = ?', [stake, userId]);
        }

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

        if (isOnlineUser) {
            await connection.query(
                `INSERT INTO transactions (user_id, transaction_type, amount, status, ticket_id) VALUES (?, 'bet_deduction', ?, 'completed', ?)`,
                [userId, stake, ticketResult.insertId]
            );
        }

        await connection.commit();
        res.json({ success: true, booking_code: bookingCode, data: { ticket_number: ticketNumber, booking_code: bookingCode } });
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
        const ticket = tickets[0];
        const items = await getTicketItems(db, ticket.id);
        const calc = calculateTicketResult(ticket, items);
        res.json({
            success: true,
            data: {
                ...ticket,
                potential_win: calc.potentialWin.toFixed(2),
                selections: items
            }
        });
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
        const [existingItems] = await connection.query('SELECT * FROM ticket_items WHERE ticket_id = ?', [ticket.id]);

        // ትኬቱ ቀድሞ የተቆረጠ ከሆነ ነገር ግን ካሼሩ Stake ቀይሮ ከላከ ማዘመን
        if (ticket.ticket_number && ticket.status !== 'void') {
            let updatedStake = parseFloat(req.body?.stake_amount ?? ticket.stake_amount);
            if (!Number.isFinite(updatedStake) || updatedStake < MIN_STAKE) updatedStake = parseFloat(ticket.stake_amount) || MIN_STAKE;
            if (updatedStake <= MAX_STAKE) {
                let recalcOdds = existingItems.reduce((acc, cur) => acc * (parseFloat(cur.odd_value) || 1), 1);
                recalcOdds = Math.round(recalcOdds * 100) / 100;
                let recalcWin = Math.round((recalcOdds * updatedStake) * 100) / 100;
                if (recalcWin <= MAX_WIN && Math.abs(updatedStake - parseFloat(ticket.stake_amount)) > 0.009) {
                    await connection.query(
                        'UPDATE tickets SET stake_amount = ?, total_odds = ?, potential_win = ? WHERE id = ?',
                        [updatedStake.toFixed(2), recalcOdds.toFixed(2), recalcWin.toFixed(2), ticket.id]
                    );
                    ticket.stake_amount = updatedStake.toFixed(2);
                    ticket.total_odds = recalcOdds.toFixed(2);
                    ticket.potential_win = recalcWin.toFixed(2);
                }
            }
            const items = await getTicketItems(connection, ticket.id);
            await connection.commit();
            return res.json({ success: true, data: { ...ticket, selections: items } });
        }

        if (ticket.status !== 'pending') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ይህ ትኬት አስቀድሞ ተቆርጧል ወይም ተሰርዟል!' });
        }

        const incomingSelections = Array.isArray(req.body?.selections) ? req.body.selections : null;
        let activeItems = existingItems;

        if (incomingSelections && incomingSelections.length > 0 && existingItems.length > 0) {
            const allowedOddIds = new Set(incomingSelections.map(s => String(s.odd_id)));
            const filtered = existingItems.filter(it => allowedOddIds.has(String(it.odd_id)));
            if (filtered.length > 0 && filtered.length < existingItems.length) {
                const removedIds = existingItems.filter(it => !allowedOddIds.has(String(it.odd_id))).map(it => it.id);
                if (removedIds.length > 0) {
                    await connection.query('DELETE FROM ticket_items WHERE id IN (?)', [removedIds]);
                }
                activeItems = filtered;
            }
        }

        if (activeItems.length === 0) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'በትኬቱ ውስጥ ምንም ጨዋታ የለም!' });
        }

        const fixtureIds = activeItems.map(i => i.fixture_id);
        const [matches] = await connection.query(
            'SELECT id, commence_time, odds_data, sport_key, home_team, away_team FROM saved_matches WHERE id IN (?)',
            [fixtureIds]
        );

        for (let item of activeItems) {
            const matchInfo = matches.find(m => String(m.id) === String(item.fixture_id));
            if (!matchInfo) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: `ጨዋታው (${item.match_info}) ስላለፈ ወይም ስለተዘጋ መቁረጥ አይቻልም!` });
            }
            if (new Date(matchInfo.commence_time).getTime() - MATCH_START_BUFFER_MS < Date.now()) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'በትኬቱ ውስጥ የጀመሩ ጨዋታዎች ስላሉ ማረጋገጥ አይቻልም! እባክዎ አዲስ ይቁረጡ።' });
            }
            const canonical = resolveCanonicalSelection(matchInfo, item);
            if (canonical && Number(canonical.odd_value) > 0) {
                item.odd_value = canonical.odd_value;
                await connection.query('UPDATE ticket_items SET odd_value = ? WHERE id = ?', [canonical.odd_value, item.id]);
            }
        }

        let finalStake = parseFloat(req.body?.stake_amount ?? ticket.stake_amount);
        if (!Number.isFinite(finalStake) || finalStake < MIN_STAKE) finalStake = parseFloat(ticket.stake_amount) || MIN_STAKE;
        if (finalStake > MAX_STAKE) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: `ከፍተኛው የውርርድ መጠን ${MAX_STAKE} ብር ነው!` });
        }

        let recalculatedOdds = activeItems.reduce((acc, cur) => acc * (parseFloat(cur.odd_value) || 1), 1);
        recalculatedOdds = Math.round(recalculatedOdds * 100) / 100;
        let recalculatedWin = Math.round((recalculatedOdds * finalStake) * 100) / 100;

        if (recalculatedWin > MAX_WIN) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: `ከፍተኛው ማሸነፊያ ${MAX_WIN} ብር ብቻ ነው!` });
        }
        
        const ticketNumber = await generateUniqueTicketNumber(connection);
        await connection.query(
            'UPDATE tickets SET ticket_number = ?, status = ?, user_id = ?, stake_amount = ?, total_odds = ?, potential_win = ?, created_at = NOW() WHERE id = ?',
            [ticketNumber, 'active', req.user.id, finalStake.toFixed(2), recalculatedOdds.toFixed(2), recalculatedWin.toFixed(2), ticket.id]
        );

        const [updatedRows] = await connection.query('SELECT * FROM tickets WHERE id = ?', [ticket.id]);
        const finalItems = await getTicketItems(connection, ticket.id);
        const confirmedTicket = {
            ...(updatedRows[0] || ticket),
            ticket_number: ticketNumber,
            status: 'active',
            user_id: req.user.id,
            stake_amount: finalStake.toFixed(2),
            total_odds: recalculatedOdds.toFixed(2),
            potential_win: recalculatedWin.toFixed(2),
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

const syncVerifiedTicketToDb = async (ticket, items, finalResult) => {
    if (!finalResult || !Array.isArray(finalResult.legs)) return items;

    for (const leg of finalResult.legs) {
        const memItem = items.find(it => it.id === leg.item_id);
        if (memItem) {
            if (['won', 'lost', 'postponed', 'pending'].includes(leg.aiStatus)) {
                memItem.match_status = leg.aiStatus;
            }
            if (leg.liveScore && leg.liveScore !== '-:-') {
                memItem.score = leg.liveScore;
            }
            memItem.explanationAmharic = leg.explanationAmharic;
            memItem.liveScore = leg.liveScore;
            memItem.aiStatus = leg.aiStatus;
        }

        if (['won', 'lost', 'postponed', 'pending'].includes(leg.aiStatus)) {
            const fullScore = leg.liveScore && leg.liveScore !== '-:-' ? leg.liveScore : null;
            const compactScore = fullScore
                ? (fullScore.match(/\d+\s*:\s*\d+(?:\s*\(\d+\))?/)?.[0] || fullScore.slice(0, 15))
                : null;
            try {
                await db.query(
                    'UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ? AND ticket_id = ?',
                    [leg.aiStatus, fullScore, leg.item_id, ticket.id]
                );
            } catch (colErr) {
                try {
                    await db.query(
                        'UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ? AND ticket_id = ?',
                        [leg.aiStatus, compactScore, leg.item_id, ticket.id]
                    );
                } catch (err2) {
                    await db.query(
                        'UPDATE ticket_items SET match_status = ? WHERE id = ? AND ticket_id = ?',
                        [leg.aiStatus, leg.item_id, ticket.id]
                    ).catch(() => {});
                }
            }
        }
    }

    const calc = calculateTicketResult(ticket, items);
    ticket.potential_win = calc.potentialWin.toFixed(2);

    if (ticket.ticket_number && !['paid', 'void', 'expired'].includes(ticket.status)) {
        const dbStatus = calc.status === 'pending' ? 'active' : calc.status;
        ticket.status = dbStatus;
        await db.query(
            `UPDATE tickets SET status = ?, potential_win = ? WHERE id = ? AND status NOT IN ('paid', 'void', 'expired')`,
            [dbStatus, calc.potentialWin.toFixed(2), ticket.id]
        ).catch(() => {});
    }

    return items;
};

// ⚡ የፍጥነት ማሻሻያ፡ ዳታቤዙ በየጥያቄው እንዳይጨናነቅ የ 15 ሰከንድ Throttle እና Batch Update ተደርጓል
let lastReconcileTime = 0;
const reconcileActiveTicketsInDb = async (force = false) => {
    if (!force && Date.now() - lastReconcileTime < 15000) return;
    lastReconcileTime = Date.now();

    try {
        await db.query(`UPDATE tickets SET status = 'pending' WHERE ticket_number IS NULL AND status NOT IN ('pending', 'void')`).catch(() => {});

        const [openTickets] = await db.query(`
            SELECT id, created_at, stake_amount, total_odds, potential_win, status
            FROM tickets
            WHERE ticket_number IS NOT NULL
              AND status IN ('active', 'pending')
            ORDER BY created_at DESC
            LIMIT 400
        `);
        if (!openTickets || openTickets.length === 0) return;

        const openIds = openTickets.map(t => t.id);
        const [allItems] = await db.query(`
            SELECT ti.ticket_id, ti.match_status, ti.odd_value, sm.commence_time
            FROM ticket_items ti
            LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id
            WHERE ti.ticket_id IN (?)
        `, [openIds]);

        const itemsByTicket = new Map();
        for (const item of allItems) {
            if (!itemsByTicket.has(item.ticket_id)) itemsByTicket.set(item.ticket_id, []);
            itemsByTicket.get(item.ticket_id).push(item);
        }

        const lostIds = [];
        for (const tkt of openTickets) {
            const tItems = itemsByTicket.get(tkt.id) || [];
            if (tItems.length === 0) continue;
            const calc = calculateTicketResult(tkt, tItems);
            const currentStoredWin = parseFloat(tkt.potential_win) || 0;
            const stakeVal = parseFloat(tkt.stake_amount) || 0;

            if (calc.status === 'lost') {
                lostIds.push(tkt.id);
                if (Math.abs(currentStoredWin - calc.potentialWin) > 0.05 && calc.potentialWin > stakeVal) {
                    await db.query(
                        `UPDATE tickets SET status = 'lost', potential_win = ? WHERE id = ? AND status NOT IN ('paid', 'void', 'expired')`,
                        [calc.potentialWin.toFixed(2), tkt.id]
                    ).catch(() => {});
                }
            } else if (calc.status === 'won') {
                const isExpired = Date.now() > calc.lastMatchTime + (3 * 24 * 60 * 60 * 1000);
                const nextStatus = isExpired ? 'expired' : 'won';
                await db.query(
                    `UPDATE tickets SET status = ?, potential_win = ? WHERE id = ? AND status NOT IN ('paid', 'void', 'expired')`,
                    [nextStatus, calc.potentialWin.toFixed(2), tkt.id]
                ).catch(() => {});
            } else if (calc.potentialWin > stakeVal && currentStoredWin <= stakeVal + 0.01) {
                await db.query(
                    `UPDATE tickets SET potential_win = ? WHERE id = ?`,
                    [calc.potentialWin.toFixed(2), tkt.id]
                ).catch(() => {});
            }
        }

        if (lostIds.length > 0) {
            await db.query(
                `UPDATE tickets SET status = 'lost' WHERE id IN (?) AND status NOT IN ('paid', 'void', 'expired')`,
                [lostIds]
            ).catch(() => {});
        }
    } catch (e) {
        console.warn('reconcileActiveTicketsInDb warning:', e.message);
    }
};

const checkTicket = async (req, res) => {
    try {
        const code = req.params.code.trim(); 
        const [tickets] = await db.query('SELECT * FROM tickets WHERE ticket_number = ? OR booking_code = ?', [code, code]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ይህ ትኬት አልተገኘም! ቁጥሩን በትክክል ያስገቡ።' });

        let ticket = tickets[0];
        let items = await getTicketItems(db, ticket.id);

        const scoreMap = await fetchDetailedMatchStats(items, ticket);
        const finalResult = await evaluateTicketAccurate(ticket, items, scoreMap);
        items = await syncVerifiedTicketToDb(ticket, items, finalResult);

        res.json({
            success: true,
            data: {
                ...ticket,
                selections: items,
                aiAnalysis: finalResult
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'ስህተት ተፈጥሯል' });
    }
};

const loadTicket = async (req, res) => {
    try {
        const [tickets] = await db.query('SELECT * FROM tickets WHERE booking_code = ?', [req.params.code.trim()]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ይህ ቡኪንግ ኮድ አልተገኘም!' });
        const items = await getTicketItems(db, tickets[0].id);
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
            'SELECT * FROM tickets WHERE ticket_number = ? FOR UPDATE',
            [ticketNumber]
        );
        
        if (tickets.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'ትኬቱ አልተገኘም (ያልታተመ ቡኪንግ ኮድ ለመክፈል አይቻልም)!' });
        }

        const ticket = tickets[0];

        if (ticket.user_id) {
            const [ownerRows] = await connection.query('SELECT role FROM users WHERE id = ?', [ticket.user_id]);
            if (ownerRows.length > 0 && ownerRows[0].role === 'user') {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'ይህ የኦንላይን ተጫዋች ትኬት ነው! ክፍያው በቀጥታ ወደ ተጫዋቹ ዋሌት ገብቷል።' });
            }
        }
        
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

        if (result.status === 'pending' && ticket.status !== 'won') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ትኬቱ አሁንም ውጤት እየጠበቀ (Pending) ነው! ሁሉም ጨዋታዎች አላለቁም።' });
        }

        const finalWinAmount = (result.status === 'won' ? result.potentialWin : Number(ticket.potential_win)).toFixed(2);

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
    let connection;
    try {
        const requestedTicketNumber = asText(req.body.ticket_number);
        if (!requestedTicketNumber) {
            return res.status(400).json({ success: false, message: 'የትኬት ቁጥር አልተላከም' });
        }
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'የካሼር መግቢያ ያስፈልጋል' });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [tickets] = await connection.query(
            'SELECT id, user_id, status, created_at, stake_amount FROM tickets WHERE ticket_number = ? FOR UPDATE',
            [requestedTicketNumber]
        );
        if (tickets.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'ትኬቱ አልተገኘም' });
        }

        const ticket = tickets[0];
        if (ticket.status !== 'active' && ticket.status !== 'pending') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ትኬቱ አክቲቭ አይደለም (መሰረዝ አይቻልም)' });
        }
        if (ticket.user_id !== req.user.id && req.user.role !== 'admin') {
            await connection.rollback();
            return res.status(403).json({ success: false, message: 'መሰረዝ የሚችለው የቆረጠው ካሼር ብቻ ነው' });
        }

        const [timeCheck] = await connection.query('SELECT TIMESTAMPDIFF(MINUTE, created_at, NOW()) as diff FROM tickets WHERE id = ?', [ticket.id]);
        if (timeCheck[0].diff >= VOID_WINDOW_MINUTES && req.user.role !== 'admin') {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: `ትኬቱን መሰረዝ የሚቻለው ከተቆረጠ በ ${VOID_WINDOW_MINUTES} ደቂቃ ውስጥ ብቻ ነው!`
            });
        }

        if (req.user.role !== 'admin') {
            const [startedItems] = await connection.query(`
                SELECT ti.id, ti.match_info
                FROM ticket_items ti
                LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id
                WHERE ti.ticket_id = ?
                  AND (
                      ti.match_status IN ('won', 'lost')
                      OR (sm.commence_time IS NOT NULL AND sm.commence_time <= NOW())
                  )
                LIMIT 1
            `, [ticket.id]);

            if (startedItems.length > 0) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: `በትኬቱ ውስጥ የጀመረ ጨዋታ (${startedItems[0].match_info}) ስላለ መሰረዝ (Void ማድረግ) አይቻልም!`
                });
            }
        }

        const [uRows] = await connection.query('SELECT role FROM users WHERE id = ?', [ticket.user_id]);
        if (uRows.length > 0 && uRows[0].role === 'user') {
            await connection.query('UPDATE users SET current_balance = current_balance + ? WHERE id = ?', [ticket.stake_amount, ticket.user_id]);
            await connection.query(
                `INSERT INTO transactions (user_id, transaction_type, amount, status, ticket_id) VALUES (?, 'bet_refund', ?, 'completed', ?)`,
                [ticket.user_id, ticket.stake_amount, ticket.id]
            );
        }

        await connection.query("UPDATE tickets SET status = 'void' WHERE id = ?", [ticket.id]);
        await connection.commit();
        res.json({ success: true, message: 'ትኬቱ በተሳካ ሁኔታ ተሰርዟል (Voided)' });
    } catch (error) {
        if (connection) await connection.rollback();
        res.status(500).json({ success: false, message: 'ትኬቱን መሰረዝ አልተቻለም' });
    } finally {
        if (connection) connection.release();
    }
};

// ==============================================================================
// 🌟 3. የአድሚን እና የካሼር ሪፖርቶች እና የገንዘብ ፍሰት መከታተያ (Reports & Cash Flow) 🌟
// ==============================================================================

const getTicketHistory = async (req, res) => {
    try {
        await reconcileActiveTicketsInDb();

        const [tickets] = await db.query(
            `SELECT t.id, t.ticket_number, t.booking_code, t.stake_amount, t.total_odds, t.potential_win, t.status, t.created_at,
                    CASE WHEN DATE(t.created_at) = CURDATE() THEN 1 ELSE 0 END AS is_today,
                    TIMESTAMPDIFF(MINUTE, t.created_at, NOW()) AS minutes_ago
             FROM tickets t
             WHERE t.user_id = ?
               AND t.ticket_number IS NOT NULL
               AND t.status != 'pending'
             ORDER BY t.created_at DESC
             LIMIT 300`,
            [req.user.id]
        );

        if (tickets.length > 0) {
            const ticketIds = tickets.map(t => t.id);
            const [items] = await db.query(
                `SELECT ti.* FROM ticket_items ti WHERE ti.ticket_id IN (?)`,
                [ticketIds]
            );
            const itemsMap = new Map();
            for (const it of items) {
                if (!itemsMap.has(it.ticket_id)) itemsMap.set(it.ticket_id, []);
                itemsMap.get(it.ticket_id).push(it);
            }
            for (const t of tickets) {
                t.selections = itemsMap.get(t.id) || [];
                const calc = calculateTicketResult(t, t.selections);
                t.potential_win = calc.potentialWin.toFixed(2);
            }
        }

        res.json({ success: true, data: tickets });
    } catch (error) {
        console.error('getTicketHistory error:', error);
        res.status(500).json({ success: false, data: [] });
    }
};

const getCashierReport = async (req, res) => {
    const { filter, date } = req.query;
    let dateCondition = "DATE(created_at) = CURDATE()";
    let queryParams = [req.user.id];

    if (filter === 'custom' && date && /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())) {
        dateCondition = "DATE(created_at) = ?";
        queryParams.push(String(date).trim());
    } else if (filter === 'week') {
        dateCondition = "YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)";
    } else if (filter === 'month') {
        dateCondition = "MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())";
    } else if (filter === 'year') {
        dateCondition = "YEAR(created_at) = YEAR(CURDATE())";
    } else if (filter === 'all') {
        dateCondition = "1=1";
    }

    try {
        await reconcileActiveTicketsInDb();

        const [periodTickets] = await db.query(`
            SELECT id, ticket_number, booking_code, stake_amount, total_odds, potential_win, status, created_at,
                   TIMESTAMPDIFF(MINUTE, created_at, NOW()) AS minutes_ago
            FROM tickets
            WHERE user_id = ?
              AND ticket_number IS NOT NULL
              AND status != 'pending'
              AND ${dateCondition}
            ORDER BY created_at DESC
        `, queryParams);

        let itemsMap = new Map();
        if (periodTickets.length > 0) {
            const pIds = periodTickets.map(t => t.id);
            const [tItems] = await db.query(
                `SELECT ticket_id, match_status, odd_value, match_info, odd_name, market_name FROM ticket_items WHERE ticket_id IN (?)`,
                [pIds]
            );
            for (const it of tItems) {
                if (!itemsMap.has(it.ticket_id)) itemsMap.set(it.ticket_id, []);
                itemsMap.get(it.ticket_id).push(it);
            }
        }

        let totalTickets = 0;
        let voidTickets = 0;
        let wonTicketsCount = 0;
        let paidTicketsCount = 0;
        let unpaidWonCount = 0;
        let lostTicketsCount = 0;
        let activeTicketsCount = 0;
        let totalRevenue = 0;
        let totalPaid = 0;
        let unpaidWinnings = 0;
        let totalWonAmount = 0;
        let activeRisk = 0;

        for (const t of periodTickets) {
            const sel = itemsMap.get(t.id) || [];
            t.selections = sel;
            const calc = calculateTicketResult(t, sel);
            let st = t.status;
            let winAmt = calc.potentialWin;

            if (st === 'active' || st === 'pending') {
                if (calc.status === 'lost') st = 'lost';
                else if (calc.status === 'won') st = 'won';
            }
            t.status = st;
            t.potential_win = winAmt.toFixed(2);

            const stakeAmt = Number(t.stake_amount || 0);

            if (st === 'void') {
                voidTickets++;
                continue;
            }

            totalTickets++;
            totalRevenue += stakeAmt;

            if (st === 'paid') {
                paidTicketsCount++;
                wonTicketsCount++;
                totalPaid += winAmt;
                totalWonAmount += winAmt;
            } else if (st === 'won') {
                unpaidWonCount++;
                wonTicketsCount++;
                unpaidWinnings += winAmt;
                totalWonAmount += winAmt;
            } else if (st === 'lost' || st === 'expired') {
                lostTicketsCount++;
            } else {
                activeTicketsCount++;
                activeRisk += winAmt;
            }
        }

        const serviceFeeTotal = totalTickets * 10;
        const grossCashCollected = totalRevenue + serviceFeeTotal;
        const netProfit = totalRevenue - totalPaid;
        const cashInHand = grossCashCollected - totalPaid;

        res.json({ 
            success: true, 
            data: {
                selected_date: filter === 'custom' ? date : null,
                total_tickets: totalTickets,
                void_tickets: voidTickets,
                service_fee_total: serviceFeeTotal,
                total_revenue: totalRevenue,
                gross_cash_collected: grossCashCollected,
                total_paid: totalPaid,
                unpaid_winnings: unpaidWinnings,
                total_won_amount: totalWonAmount,
                active_risk: activeRisk,
                won_tickets_count: wonTicketsCount,
                paid_tickets_count: paidTicketsCount,
                unpaid_won_count: unpaidWonCount,
                lost_tickets_count: lostTicketsCount,
                active_tickets_count: activeTicketsCount,
                net_profit: netProfit,
                cash_in_hand: cashInHand,
                tickets: periodTickets.slice(0, 300)
            } 
        });
    } catch (error) {
        console.error('getCashierReport error:', error);
        res.status(500).json({ success: false });
    }
};

const getSummaryReport = async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false });
    const { filter, date } = req.query;

    let dateCondition = "DATE(t.created_at) = CURDATE()";
    let queryParams = [];

    if (filter === 'custom' && date && /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())) {
        dateCondition = "DATE(t.created_at) = ?";
        queryParams = [String(date).trim()];
    } else if (filter === 'week') {
        dateCondition = "YEARWEEK(t.created_at, 1) = YEARWEEK(CURDATE(), 1)";
    } else if (filter === 'month') {
        dateCondition = "MONTH(t.created_at) = MONTH(CURDATE()) AND YEAR(t.created_at) = YEAR(CURDATE())";
    } else if (filter === 'year') {
        dateCondition = "YEAR(t.created_at) = YEAR(CURDATE())";
    } else if (filter === 'all') {
        dateCondition = "1=1";
    }

    try {
        await reconcileActiveTicketsInDb();

        const [rawTickets] = await db.query(`
            SELECT t.id, t.user_id, t.ticket_number, t.booking_code, t.stake_amount, t.total_odds, t.potential_win, t.status, t.created_at,
                   u.username as cashier, u.role
            FROM tickets t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE ${dateCondition}
              AND t.ticket_number IS NOT NULL
              AND t.status != 'pending'
            ORDER BY t.created_at DESC
        `, queryParams);

        let itemsByTicket = new Map();
        if (rawTickets.length > 0) {
            const tIds = rawTickets.map(t => t.id);
            const [tItems] = await db.query(`
                SELECT ticket_id, match_status, odd_value, match_info, odd_name, market_name
                FROM ticket_items
                WHERE ticket_id IN (?)
            `, [tIds]);
            for (const it of tItems) {
                if (!itemsByTicket.has(it.ticket_id)) itemsByTicket.set(it.ticket_id, []);
                itemsByTicket.get(it.ticket_id).push(it);
            }
        }

        const [staffUsers] = await db.query(`SELECT id, username, role FROM users WHERE role IN ('cashier', 'admin') ORDER BY username ASC`);
        const [onlineUsersCount] = await db.query("SELECT COUNT(id) as count FROM users WHERE role = 'user'");

        let totalTickets = 0;
        let voidTickets = 0;
        let shopTicketsCount = 0;
        let totalRevenue = 0;
        let totalPayout = 0;
        let totalPaidOut = 0;
        let totalUnpaidWon = 0;
        let totalActiveRisk = 0;
        let totalSavedFromLost = 0;
        let winningTicketsCount = 0;
        let paidTicketsCount = 0;
        let unpaidWonCount = 0;
        let lostTicketsCount = 0;
        let activeTicketsCount = 0;

        let onlineStats = { tickets_sold: 0, winning_tickets_count: 0, lost_tickets_count: 0, revenue: 0, payout: 0 };
        const cashierMap = new Map();

        for (const s of staffUsers) {
            cashierMap.set(s.id, {
                user_id: s.id,
                cashier: s.username,
                role: s.role,
                tickets_sold: 0,
                void_tickets: 0,
                winning_tickets_count: 0,
                paid_tickets_count: 0,
                unpaid_tickets_count: 0,
                lost_tickets_count: 0,
                active_tickets_count: 0,
                revenue: 0,
                payout: 0,
                paid_out: 0,
                unpaid_won: 0,
                active_risk: 0
            });
        }

        const winningTickets = [];
        const periodTickets = [];

        for (const t of rawTickets) {
            const items = itemsByTicket.get(t.id) || [];
            const calc = calculateTicketResult(t, items);
            let effectiveStatus = t.status;
            let effectiveWin = calc.potentialWin;

            if (effectiveStatus === 'active' || effectiveStatus === 'pending') {
                if (calc.status === 'lost') effectiveStatus = 'lost';
                else if (calc.status === 'won') effectiveStatus = 'won';
            }

            const stake = Number(t.stake_amount || 0);
            const isOnline = t.role === 'user';

            const enrichedTicket = {
                ...t,
                cashier: t.cashier || (isOnline ? 'ኦንላይን ተጫዋች (Online)' : 'ካሼር (Shop)'),
                status: effectiveStatus,
                potential_win: effectiveWin.toFixed(2),
                selections: items
            };
            periodTickets.push(enrichedTicket);

            if (effectiveStatus === 'void') {
                voidTickets++;
                if (!isOnline && t.user_id && cashierMap.has(t.user_id)) {
                    cashierMap.get(t.user_id).void_tickets++;
                }
                continue;
            }

            totalTickets++;
            totalRevenue += stake;

            if (isOnline) {
                onlineStats.tickets_sold++;
                onlineStats.revenue += stake;
                if (effectiveStatus === 'won' || effectiveStatus === 'paid') {
                    onlineStats.winning_tickets_count++;
                    onlineStats.payout += effectiveWin;
                } else if (effectiveStatus === 'lost' || effectiveStatus === 'expired') {
                    onlineStats.lost_tickets_count++;
                }
            } else {
                shopTicketsCount++;
                const cKey = t.user_id && cashierMap.has(t.user_id) ? t.user_id : 'shop_default';
                if (!cashierMap.has(cKey)) {
                    cashierMap.set(cKey, {
                        user_id: 0,
                        cashier: t.cashier || 'Shop Cashier',
                        role: 'cashier',
                        tickets_sold: 0,
                        void_tickets: 0,
                        winning_tickets_count: 0,
                        paid_tickets_count: 0,
                        unpaid_tickets_count: 0,
                        lost_tickets_count: 0,
                        active_tickets_count: 0,
                        revenue: 0,
                        payout: 0,
                        paid_out: 0,
                        unpaid_won: 0,
                        active_risk: 0
                    });
                }
                const cObj = cashierMap.get(cKey);
                cObj.tickets_sold++;
                cObj.revenue += stake;

                if (effectiveStatus === 'paid') {
                    cObj.winning_tickets_count++;
                    cObj.paid_tickets_count++;
                    cObj.payout += effectiveWin;
                    cObj.paid_out += effectiveWin;
                } else if (effectiveStatus === 'won') {
                    cObj.winning_tickets_count++;
                    cObj.unpaid_tickets_count++;
                    cObj.payout += effectiveWin;
                    cObj.unpaid_won += effectiveWin;
                } else if (effectiveStatus === 'lost' || effectiveStatus === 'expired') {
                    cObj.lost_tickets_count++;
                } else {
                    cObj.active_tickets_count++;
                    cObj.active_risk += effectiveWin;
                }
            }

            if (effectiveStatus === 'paid') {
                winningTicketsCount++;
                paidTicketsCount++;
                totalPayout += effectiveWin;
                totalPaidOut += effectiveWin;
                winningTickets.push(enrichedTicket);
            } else if (effectiveStatus === 'won') {
                winningTicketsCount++;
                unpaidWonCount++;
                totalPayout += effectiveWin;
                totalUnpaidWon += effectiveWin;
                winningTickets.push(enrichedTicket);
            } else if (effectiveStatus === 'lost' || effectiveStatus === 'expired') {
                lostTicketsCount++;
                totalSavedFromLost += effectiveWin;
                if (effectiveStatus === 'expired') winningTickets.push(enrichedTicket);
            } else {
                activeTicketsCount++;
                totalActiveRisk += effectiveWin;
            }
        }

        const cashierStats = Array.from(cashierMap.values())
            .filter(c => c.role === 'cashier' || c.tickets_sold > 0)
            .sort((a, b) => b.revenue - a.revenue);

        const serviceFeeTotal = shopTicketsCount * 10;
        const grossCashIn = totalRevenue + serviceFeeTotal;
        const netCashFlow = grossCashIn - totalPaidOut;
        const netProfitAfterLiability = grossCashIn - totalPayout;

        res.json({
            success: true,
            data: {
                selectedDate: filter === 'custom' ? date : null,
                totalTickets,
                voidTickets,
                shopTicketsCount,
                serviceFeeTotal,
                totalRevenue,
                grossCashIn,
                totalPayout,
                totalPaidOut,
                totalUnpaidWon,
                totalActiveRisk,
                totalSavedFromLost,
                netCashFlow,
                netProfitAfterLiability,
                winningTicketsCount,
                paidTicketsCount,
                unpaidWonCount,
                lostTicketsCount,
                activeTicketsCount,
                activeOnlineUsers: Number(onlineUsersCount[0]?.count || 0),
                onlineStats,
                cashierStats,
                winningTickets: winningTickets.slice(0, 150),
                periodTickets: periodTickets.slice(0, 250)
            }
        });
    } catch (error) {
        console.error('getSummaryReport error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getStaffList = async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false });
    try {
        const [staff] = await db.query("SELECT id, username, role, created_at FROM users WHERE role IN ('cashier', 'admin') ORDER BY created_at DESC");
        res.json({ success: true, data: staff });
    } catch (error) { res.status(500).json({ success: false }); }
};

const getAllTickets = async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'ያልተፈቀደ (Unauthorized)' });
    
    try {
        await reconcileActiveTicketsInDb();

        const [tickets] = await db.query(`
            SELECT t.*, u.username as cashier, u.role,
                   CASE WHEN DATE(t.created_at) = CURDATE() THEN 1 ELSE 0 END AS is_today
            FROM tickets t 
            LEFT JOIN users u ON t.user_id = u.id 
            WHERE t.ticket_number IS NOT NULL
            ORDER BY t.created_at DESC
            LIMIT 400
        `);
        
        let formattedTickets = [];
        if (tickets.length > 0) {
            const ticketIds = tickets.map(t => t.id);
            const [selections] = await db.query(
                `SELECT ti.* FROM ticket_items ti WHERE ti.ticket_id IN (?)`,
                [ticketIds]
            );

            const selMap = new Map();
            for (const s of selections) {
                if (!selMap.has(s.ticket_id)) selMap.set(s.ticket_id, []);
                selMap.get(s.ticket_id).push(s);
            }

            formattedTickets = tickets.map(ticket => {
                const items = selMap.get(ticket.id) || [];
                const calc = calculateTicketResult(ticket, items);
                return {
                    ...ticket,
                    potential_win: calc.potentialWin.toFixed(2),
                    cashier: ticket.cashier || (ticket.role === 'user' ? 'ኦንላይን ተጫዋች (Online)' : 'ካሼር (Shop)'),
                    selections: items
                };
            });
        }

        res.json({ success: true, data: formattedTickets });
    } catch (error) {
        console.error('Error fetching all tickets:', error);
        res.status(500).json({ success: false, message: 'ትኬቶችን ማምጣት አልተቻለም!' });
    }
};

// ==============================================================================
// 🌟 4. ሁሉንም ማርኬቶች (ALL MARKETS) 100% በትክክል የሚፈትሽ የተሟላ የውርርድ ሞተር 🌟
// ==============================================================================

const CUSTOM_MARKET_MAP = {
    "1": "Match Result", "h2h": "Match Result",
    "2": "Draw No Bet",
    "3": "2nd Half Result",
    "4": "Asian Handicap", "handicap": "European Handicap",
    "5": "Total Goals", "totals": "Total Goals", "50": "Total Goals",
    "6": "1st Half Total Goals", "totals_h1": "1st Half Total Goals", "1st_half_total": "1st Half Total Goals",
    "7": "Halftime/Fulltime",
    "8": "Both Teams To Score", "btts": "Both Teams To Score",
    "9": "2nd Half Total Goals", "totals_h2": "2nd Half Total Goals", "2nd_half_total": "2nd Half Total Goals",
    "10": "Correct Score", "31": "Correct Score",
    "11": "Highest Scoring Half",
    "12": "Double Chance", "dc": "Double Chance", "double_chance": "Double Chance",
    "13": "1st Half Result", "h2h_h1": "1st Half Result",
    "14": "First Goal",
    "15": "Last Goal",
    "16": "Home Total Goals",
    "17": "Away Total Goals",
    "19": "Clean Sheet - Home",
    "20": "Clean Sheet - Away",
    "21": "Odd/Even",
    "22": "1st Half Odd/Even",
    "24": "1X2 & Both Teams To Score",
    "25": "1X2 & Total",
    "26": "2nd Half Both Teams To Score",
    "27": "Win to Nil - Home",
    "28": "Win to Nil - Away",
    "32": "1st Half Double Chance",
    "33": "Double Chance & Both Teams To Score",
    "34": "1st Half Both Teams To Score",
    "35": "Both Halves Over 1.5",
    "36": "Win Both Halves",
    "37": "Win Either Half",
    "38": "Exact Goals",
    "39": "Score in Both Halves",
    "49": "Total & Both Teams To Score",
    "54": "10 Minutes - 1X2",
    "62": "Which Team To Score",
    "79": "Corner 1X2",
    "80": "Total Cards",
    "83": "Sending Off",
    "85": "Total Corners",
    "86": "Last Corner",
    "87": "First Corner",
    "88": "Odd/Even Corners",
    "89": "Home Total Corners",
    "90": "Away Total Corners",
    "92": "Anytime Goalscorer",
    "93": "First Goalscorer",
    "94": "Last Goalscorer",
    "295": "Corner Range",
    "349": "Goal Range"
};

const is1stHalfTotalMarket = (mId, mLower) => {
    if (mLower.includes('corner') || mLower.includes('card')) return false;
    if (mId === '6' || mId === 'totals_h1' || mId === '1st_half_total') return true;
    const has1stHalf =
        mLower.includes('1st half') ||
        mLower.includes('first half') ||
        mLower.includes('1h ') ||
        mLower.includes('half time') ||
        mLower.includes('halftime');
    const hasTotalOrOU =
        mLower.includes('total') ||
        mLower.includes('over/under') ||
        mLower.includes('goal line') ||
        mLower.includes('goals over/under');
    return has1stHalf && hasTotalOrOU;
};

const is2ndHalfTotalMarket = (mId, mLower) => {
    if (mLower.includes('corner') || mLower.includes('card')) return false;
    if (mId === '9' || mId === 'totals_h2' || mId === '2nd_half_total') return true;
    const has2ndHalf =
        mLower.includes('2nd half') ||
        mLower.includes('second half') ||
        mLower.includes('2h ');
    const hasTotalOrOU =
        mLower.includes('total') ||
        mLower.includes('over/under') ||
        mLower.includes('goal line') ||
        mLower.includes('goals over/under');
    return has2ndHalf && hasTotalOrOU;
};

const resolveMarketDetails = (item) => {
    const rawId = asText(item.market_id).toLowerCase();
    const rawKey = asText(item.market_key).toLowerCase();
    const oddPrefix = asText(item.odd_id).split('_')[0].toLowerCase();
    let marketName = asText(item.market_name);

    if (
        !marketName ||
        marketName.toLowerCase() === 'undefined' ||
        marketName.toLowerCase() === 'null' ||
        marketName === 'Market' ||
        marketName === 'Match Market'
    ) {
        marketName = '';
    }

    const mappedBase =
        CUSTOM_MARKET_MAP[rawId] ||
        CUSTOM_MARKET_MAP[rawKey] ||
        CUSTOM_MARKET_MAP[oddPrefix] ||
        '';

    let canonicalMarket = marketName || mappedBase || 'Match Market';
    if (!marketName && mappedBase) {
        canonicalMarket = mappedBase;
    } else if (marketName && mappedBase) {
        const mNameLower = marketName.toLowerCase();
        if (mNameLower.includes('1st half') || mNameLower.includes('first half') || mNameLower.includes('2nd half') || mNameLower.includes('second half')) {
            canonicalMarket = marketName;
        } else {
            canonicalMarket = mappedBase;
        }
    }

    let mId = rawId || (CUSTOM_MARKET_MAP[oddPrefix] ? oddPrefix : '') || rawKey;
    const mLower = `${canonicalMarket} ${marketName} ${mappedBase} ${rawKey} ${oddPrefix}`.trim().toLowerCase();

    if (!mId) {
        if (is1stHalfTotalMarket('', mLower)) mId = '6';
        else if (is2ndHalfTotalMarket('', mLower)) mId = '9';
    }

    return { mId, canonicalMarket, mLower };
};

const stripAccents = (str) =>
    String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ø/gi, 'o')
        .replace(/æ/gi, 'ae')
        .replace(/ß/g, 'ss');

const normalizeTeam = (name) =>
    stripAccents(name)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

const STOP_TEAM_TOKENS = new Set([
    'w', 'women', 'fem', 'female', 'ladies', 'fc', 'cf', 'sc', 'fk', 'sk', 'bk', 'ik',
    'gik', 'dff', 'ff', 'if', 'afc', 'ac', 'as', 'sv', 'tsv', 'vfb', 'vfl', 'bsc',
    'ud', 'cd', 'sd', 'rcd', 'ca', 'cs', 'ks', 'nk', 'hnk', 'pfk', 'pfc', 'ofk',
    'u17', 'u18', 'u19', 'u20', 'u21', 'u23', 'ii', '2', 'b', 'club', 'team', 'de', 'al'
]);

const getCleanTeamWords = (name) => {
    const clean = stripAccents(name)
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ');
    const words = clean.split(/\s+/).filter(w => w.length > 1 && !STOP_TEAM_TOKENS.has(w));
    return words.length > 0 ? words : clean.split(/\s+/).filter(Boolean);
};

const getCoreTeamKey = (name) => {
    const words = getCleanTeamWords(name);
    return words.join('');
};

const teamsMatch = (nameA, nameB) => {
    if (!nameA || !nameB) return false;
    const normA = normalizeTeam(nameA);
    const normB = normalizeTeam(nameB);
    if (!normA || !normB) return false;
    if (normA === normB || normA.includes(normB) || normB.includes(normA)) return true;

    const coreA = getCoreTeamKey(nameA);
    const coreB = getCoreTeamKey(nameB);
    if (coreA && coreB && (coreA === coreB || coreA.includes(coreB) || coreB.includes(coreA))) return true;

    const wordsA = getCleanTeamWords(nameA);
    const wordsB = getCleanTeamWords(nameB);
    for (const wa of wordsA) {
        if (wa.length < 4) continue;
        const stemA = wa.endsWith('s') && wa.length > 5 ? wa.slice(0, -1) : wa;
        for (const wb of wordsB) {
            if (wb.length < 4) continue;
            const stemB = wb.endsWith('s') && wb.length > 5 ? wb.slice(0, -1) : wb;
            if (stemA === stemB || (stemA.length >= 5 && stemB.includes(stemA)) || (stemB.length >= 5 && stemA.includes(stemB))) {
                return true;
            }
        }
    }
    return false;
};

const extractStatValue = (statsArray, statNames) => {
    if (!Array.isArray(statsArray)) return null;
    for (const st of statsArray) {
        const n = String(st.name || st.type || st.key || '').toLowerCase();
        const l = String(st.label || st.displayName || '').toLowerCase();
        const a = String(st.abbreviation || '').toLowerCase();
        if (statNames.some(target => n === target || l.includes(target) || n.includes(target) || a === target)) {
            const rawVal = st.displayValue ?? st.value;
            if (rawVal === null || rawVal === undefined) return 0;
            const val = parseFloat(rawVal);
            if (Number.isFinite(val)) return val;
        }
    }
    return null;
};

const getApiFootballKeysList = async () => {
    const keysList = [];
    try {
        const [rows] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'api_football_key'");
        if (rows.length > 0 && rows[0].setting_value && !rows[0].setting_value.includes('ይቀይሩ')) {
            const dbKeys = rows[0].setting_value.split(',').map(k => k.trim()).filter(k => k.length > 0);
            keysList.push(...dbKeys);
        }
    } catch (e) {}

    const directKey =
        process.env.API_FOOTBALL_KEY ||
        process.env.APISPORTS_KEY ||
        process.env.API_SPORTS_KEY ||
        process.env.SPORTS_API_KEY ||
        process.env.FOOTBALL_API_KEY ||
        process.env.RAPIDAPI_KEY ||
        process.env.FOOTBALL_KEY ||
        process.env.ODDS_API_KEY;
    if (directKey && !keysList.includes(String(directKey).trim())) {
        keysList.push(String(directKey).trim());
    }

    return keysList;
};

const fetchApiFootballFixture = async (fixtureId) => {
    if (!fixtureId || !/^\d+$/.test(String(fixtureId))) return null;
    const apiKeys = await getApiFootballKeysList();
    if (apiKeys.length === 0) return null;

    try {
        let f = null;
        for (const apiKey of apiKeys) {
            try {
                const res = await axios.get(`https://v3.football.api-sports.io/fixtures?id=${fixtureId}`, {
                    headers: { 'x-apisports-key': apiKey },
                    timeout: 4500
                });
                if (res.data?.response?.[0]) {
                    f = res.data.response[0];
                    break;
                }
            } catch (err) {
                const st = err.response?.status;
                if (st === 429 || st === 403 || st === 401) continue;
                break;
            }
        }
        if (!f) return null;

        const statusShort = f.fixture?.status?.short || '';
        const completed = ['FT', 'AET', 'PEN'].includes(statusShort);
        const firstHalfCompleted = completed || ['HT', '2H', 'ET', 'BT', 'P'].includes(statusShort);
        const state = ['NS', 'TBD'].includes(statusShort) ? 'pre' : completed ? 'post' : 'in';

        const hScore = Number(f.score?.fulltime?.home ?? f.goals?.home ?? 0);
        const aScore = Number(f.score?.fulltime?.away ?? f.goals?.away ?? 0);
        const htHome = f.score?.halftime?.home !== null && f.score?.halftime?.home !== undefined ? Number(f.score.halftime.home) : null;
        const htAway = f.score?.halftime?.away !== null && f.score?.halftime?.away !== undefined ? Number(f.score.halftime.away) : null;

        const homeStats = f.statistics?.find(s => s.team?.id === f.teams?.home?.id)?.statistics || [];
        const awayStats = f.statistics?.find(s => s.team?.id === f.teams?.away?.id)?.statistics || [];

        const homeCorners = extractStatValue(homeStats, ['corner kicks', 'corners']);
        const awayCorners = extractStatValue(awayStats, ['corner kicks', 'corners']);
        const homeRed = extractStatValue(homeStats, ['red cards']) ?? 0;
        const awayRed = extractStatValue(awayStats, ['red cards']) ?? 0;
        const homeYellow = extractStatValue(homeStats, ['yellow cards']) ?? 0;
        const awayYellow = extractStatValue(awayStats, ['yellow cards']) ?? 0;

        const goalEvents = [];
        for (const ev of (f.events || [])) {
            if (ev.type === 'Goal' && ev.detail !== 'Missed Penalty') {
                const minute = Number(ev.time?.elapsed ?? 90);
                if (minute <= 90) {
                    const side = ev.team?.id === f.teams?.home?.id ? 'home' : 'away';
                    const scorerName = String(ev.player?.name || '').toLowerCase();
                    goalEvents.push({ minute, side, scorerName });
                }
            }
        }

        return {
            homeName: f.teams?.home?.name,
            awayName: f.teams?.away?.name,
            homeScore: hScore,
            awayScore: aScore,
            htHome,
            htAway,
            firstHalfCompleted,
            homeCorners,
            awayCorners,
            htHomeCorners: null,
            htAwayCorners: null,
            shHomeCorners: null,
            shAwayCorners: null,
            homeRed,
            awayRed,
            homeYellow,
            awayYellow,
            goalEvents,
            scorers: goalEvents.map(g => g.scorerName).filter(Boolean),
            firstGoalTeam: goalEvents.length > 0 ? goalEvents[0].side : null,
            lastGoalTeam: goalEvents.length > 0 ? goalEvents[goalEvents.length - 1].side : null,
            firstCornerTeam: null,
            lastCornerTeam: null,
            scoreStr: state === 'pre' ? '-:-' : `${hScore}:${aScore}`,
            state,
            completed
        };
    } catch (e) {
        return null;
    }
};

// ==============================================================================
// 🌟 SofaScore Public API (1ኛ እና 2ኛ አጋማሽ ኮርነር፣ ጎል እና ሁሉንም ሊጎች ለማምጣት) 🌟
// ==============================================================================
const SOFASCORE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.sofascore.com',
    'Referer': 'https://www.sofascore.com/'
};

const extractSofaPeriodStats = (statisticsArray, periodName) => {
    if (!Array.isArray(statisticsArray)) return null;
    const periodObj = statisticsArray.find(p => String(p.period || '').toUpperCase() === periodName.toUpperCase());
    if (!periodObj || !Array.isArray(periodObj.groups)) return null;

    let cornersH = null;
    let cornersA = null;
    let yellowH = 0;
    let yellowA = 0;
    let redH = 0;
    let redA = 0;

    for (const grp of periodObj.groups) {
        for (const item of (grp.statisticsItems || [])) {
            const key = String(item.key || '').toLowerCase();
            const name = String(item.name || '').toLowerCase();
            const hVal = item.homeValue !== undefined ? Number(item.homeValue) : parseFloat(item.home);
            const aVal = item.awayValue !== undefined ? Number(item.awayValue) : parseFloat(item.away);

            if (key === 'cornerkicks' || name.includes('corner')) {
                if (Number.isFinite(hVal) && Number.isFinite(aVal)) {
                    cornersH = hVal;
                    cornersA = aVal;
                }
            } else if (key === 'yellowcards' || name.includes('yellow card')) {
                if (Number.isFinite(hVal)) yellowH = hVal;
                if (Number.isFinite(aVal)) yellowA = aVal;
            } else if (key === 'redcards' || name.includes('red card')) {
                if (Number.isFinite(hVal)) redH = hVal;
                if (Number.isFinite(aVal)) redA = aVal;
            }
        }
    }

    return { cornersH, cornersA, yellowH, yellowA, redH, redA };
};

const buildMatchFromSofaEvent = async (ev) => {
    if (!ev || !ev.id) return null;
    try {
        const [eventRes, statsRes, incRes] = await Promise.all([
            axios.get(`https://api.sofascore.com/api/v1/event/${ev.id}`, { headers: SOFASCORE_HEADERS, timeout: 4000 }).catch(() => null),
            axios.get(`https://api.sofascore.com/api/v1/event/${ev.id}/statistics`, { headers: SOFASCORE_HEADERS, timeout: 4000 }).catch(() => null),
            axios.get(`https://api.sofascore.com/api/v1/event/${ev.id}/incidents`, { headers: SOFASCORE_HEADERS, timeout: 4000 }).catch(() => null)
        ]);

        const fullEv = eventRes?.data?.event || ev;
        const statusType = String(fullEv.status?.type || '').toLowerCase();
        const statusDesc = String(fullEv.status?.description || '').toLowerCase();
        const statusCode = Number(fullEv.status?.code || 0);
        const completed = statusType === 'finished';
        const firstHalfCompleted =
            completed ||
            statusCode === 31 ||
            statusCode === 7 ||
            statusDesc.includes('halftime') ||
            statusDesc.includes('2nd half') ||
            (fullEv.homeScore?.period2 !== undefined && fullEv.homeScore?.period2 !== null);
        const state = statusType === 'notstarted' ? 'pre' : completed ? 'post' : 'in';

        const hScoreObj = fullEv.homeScore || {};
        const aScoreObj = fullEv.awayScore || {};

        let htHome = hScoreObj.period1 !== undefined && hScoreObj.period1 !== null ? Number(hScoreObj.period1) : null;
        let htAway = aScoreObj.period1 !== undefined && aScoreObj.period1 !== null ? Number(aScoreObj.period1) : null;

        let hScore = hScoreObj.normaltime !== undefined && hScoreObj.normaltime !== null
            ? Number(hScoreObj.normaltime)
            : (hScoreObj.current !== undefined && hScoreObj.current !== null ? Number(hScoreObj.current) : 0);
        let aScore = aScoreObj.normaltime !== undefined && aScoreObj.normaltime !== null
            ? Number(aScoreObj.normaltime)
            : (aScoreObj.current !== undefined && aScoreObj.current !== null ? Number(aScoreObj.current) : 0);

        if (htHome !== null && htAway !== null && hScoreObj.period2 !== undefined && aScoreObj.period2 !== undefined) {
            hScore = htHome + Number(hScoreObj.period2);
            aScore = htAway + Number(aScoreObj.period2);
        }

        const statsArr = statsRes?.data?.statistics || [];
        const allStats = extractSofaPeriodStats(statsArr, 'ALL');
        const firstHalfStats = extractSofaPeriodStats(statsArr, '1ST');
        const secondHalfStats = extractSofaPeriodStats(statsArr, '2ND');

        let homeCorners = allStats?.cornersH ?? null;
        let awayCorners = allStats?.cornersA ?? null;
        let htHomeCorners = firstHalfStats?.cornersH ?? null;
        let htAwayCorners = firstHalfStats?.cornersA ?? null;
        let shHomeCorners = secondHalfStats?.cornersH ?? null;
        let shAwayCorners = secondHalfStats?.cornersA ?? null;

        if (homeCorners !== null && awayCorners !== null) {
            if (htHomeCorners !== null && htAwayCorners !== null && (shHomeCorners === null || shAwayCorners === null)) {
                shHomeCorners = Math.max(0, homeCorners - htHomeCorners);
                shAwayCorners = Math.max(0, awayCorners - htAwayCorners);
            } else if (shHomeCorners !== null && shAwayCorners !== null && (htHomeCorners === null || htAwayCorners === null)) {
                htHomeCorners = Math.max(0, homeCorners - shHomeCorners);
                htAwayCorners = Math.max(0, awayCorners - shAwayCorners);
            }
        } else if (htHomeCorners !== null && htAwayCorners !== null && shHomeCorners !== null && shAwayCorners !== null) {
            homeCorners = htHomeCorners + shHomeCorners;
            awayCorners = htAwayCorners + shAwayCorners;
        }

        const incidents = incRes?.data?.incidents || [];
        const goalEvents = [];
        for (const inc of incidents) {
            if (inc.incidentType === 'period' && String(inc.text || '').toUpperCase() === 'HT') {
                if (htHome === null && inc.homeScore !== undefined) htHome = Number(inc.homeScore);
                if (htAway === null && inc.awayScore !== undefined) htAway = Number(inc.awayScore);
            }
            if (inc.incidentType === 'goal' && inc.incidentClass !== 'missedPenalty') {
                const minute = Number(inc.time ?? 90);
                if (minute <= 90) {
                    const side = inc.isHome === true ? 'home' : inc.isHome === false ? 'away' : null;
                    const scorerName = String(inc.player?.name || inc.player?.shortName || '').toLowerCase();
                    if (side) goalEvents.push({ minute, side, scorerName });
                }
            }
        }
        goalEvents.sort((a, b) => a.minute - b.minute);

        return {
            homeName: fullEv.homeTeam?.name,
            awayName: fullEv.awayTeam?.name,
            homeScore: hScore,
            awayScore: aScore,
            htHome,
            htAway,
            firstHalfCompleted,
            homeCorners,
            awayCorners,
            htHomeCorners,
            htAwayCorners,
            shHomeCorners,
            shAwayCorners,
            homeRed: allStats ? allStats.redH : null,
            awayRed: allStats ? allStats.redA : null,
            homeYellow: allStats ? allStats.yellowH : null,
            awayYellow: allStats ? allStats.yellowA : null,
            goalEvents,
            scorers: goalEvents.map(g => g.scorerName).filter(Boolean),
            firstGoalTeam: goalEvents.length > 0 ? goalEvents[0].side : null,
            lastGoalTeam: goalEvents.length > 0 ? goalEvents[goalEvents.length - 1].side : null,
            firstCornerTeam: null,
            lastCornerTeam: null,
            scoreStr: state === 'pre' ? '-:-' : `${hScore}:${aScore}`,
            state,
            completed
        };
    } catch (e) {
        return null;
    }
};

const fetchSofaScoreForItem = async (homeTeam, awayTeam, targetTimestampMs, sofaScheduleCache) => {
    if (!homeTeam || !awayTeam) return null;

    const pickBestEvent = (eventsList) => {
        if (!Array.isArray(eventsList)) return null;
        let best = null;
        let bestDiff = Infinity;
        for (const ev of eventsList) {
            const hName = ev?.homeTeam?.name || ev?.homeTeam?.shortName || '';
            const aName = ev?.awayTeam?.name || ev?.awayTeam?.shortName || '';
            if (teamsMatch(homeTeam, hName) && teamsMatch(awayTeam, aName)) {
                const evTimeMs = (ev.startTimestamp || 0) * 1000;
                const diff = targetTimestampMs && evTimeMs ? Math.abs(evTimeMs - targetTimestampMs) : 0;
                const isFinished = String(ev.status?.type || '').toLowerCase() === 'finished';
                if (!best || (isFinished && String(best.status?.type || '').toLowerCase() !== 'finished') || diff < bestDiff) {
                    best = ev;
                    bestDiff = diff;
                }
            }
        }
        return best;
    };

    try {
        if (sofaScheduleCache && Object.keys(sofaScheduleCache).length > 0) {
            for (const events of Object.values(sofaScheduleCache)) {
                const matchedEv = pickBestEvent(events);
                if (matchedEv) {
                    return await buildMatchFromSofaEvent(matchedEv);
                }
            }
        }

        const cleanH = getCleanTeamWords(homeTeam).join(' ') || homeTeam;
        const cleanA = getCleanTeamWords(awayTeam).join(' ') || awayTeam;
        const queries = [`${cleanH} ${cleanA}`, `${homeTeam} ${awayTeam}`, cleanH];

        const candidateTeamIds = [];
        for (const q of queries) {
            const sRes = await axios.get(
                `https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(q)}`,
                { headers: SOFASCORE_HEADERS, timeout: 4000 }
            ).catch(() => null);

            const results = sRes?.data?.results || [];
            const eventResults = results
                .filter(r => r.type === 'event' && r.entity)
                .map(r => r.entity);

            const matchedEv = pickBestEvent(eventResults);
            if (matchedEv) {
                return await buildMatchFromSofaEvent(matchedEv);
            }

            for (const r of results) {
                if (r.type === 'team' && r.entity?.id && r.entity?.sport?.slug === 'football') {
                    if (teamsMatch(homeTeam, r.entity.name) || teamsMatch(awayTeam, r.entity.name)) {
                        if (!candidateTeamIds.includes(r.entity.id)) {
                            candidateTeamIds.push(r.entity.id);
                        }
                    }
                }
            }
            if (candidateTeamIds.length > 0) break;
        }

        for (const teamId of candidateTeamIds.slice(0, 2)) {
            const lastRes = await axios.get(
                `https://api.sofascore.com/api/v1/team/${teamId}/events/last/0`,
                { headers: SOFASCORE_HEADERS, timeout: 4000 }
            ).catch(() => null);

            const events = lastRes?.data?.events || [];
            const matchedEv = pickBestEvent(events);
            if (matchedEv) {
                return await buildMatchFromSofaEvent(matchedEv);
            }
        }
    } catch (e) {}

    return null;
};

// ⚡ የፍጥነት ማሻሻያ፡ የቀናት ዝርዝር በ Promise.all በትይዩ (Parallel) እንዲመጣ ተደርጓል
const fetchDetailedMatchStats = async (items, ticket) => {
    const scoreMap = {};
    const sofaScheduleCache = {};
    try {
        const isoDates = new Set();
        const addDateWithNeighbors = (dateVal) => {
            if (!dateVal) return;
            const d = new Date(dateVal);
            if (isNaN(d.getTime())) return;
            for (const offsetDays of [0, -1, 1]) {
                const shifted = new Date(d.getTime() + offsetDays * 86400000);
                isoDates.add(shifted.toISOString().slice(0, 10));
            }
        };

        addDateWithNeighbors(new Date());
        if (ticket?.created_at) {
            addDateWithNeighbors(ticket.created_at);
        }
        for (const item of items) {
            if (item.commence_time) {
                addDateWithNeighbors(item.commence_time);
            }
        }

        const dateList = Array.from(isoDates).slice(0, 5);

        await Promise.all(
            dateList.map(async (isoDate) => {
                const espnDate = isoDate.replace(/-/g, '');
                const [espnRes, sofaRes] = await Promise.all([
                    axios.get(
                        `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${espnDate}`,
                        { timeout: 4500 }
                    ).catch(() => null),
                    axios.get(
                        `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${isoDate}`,
                        { headers: SOFASCORE_HEADERS, timeout: 4500 }
                    ).catch(() => null)
                ]);

                if (Array.isArray(sofaRes?.data?.events)) {
                    sofaScheduleCache[isoDate] = sofaRes.data.events;
                }

                const events = espnRes?.data?.events || [];
                for (const ev of events) {
                    const comp = ev?.competitions?.[0];
                    if (!comp) continue;
                    const competitors = comp.competitors || [];
                    const home = competitors.find(c => c.homeAway === 'home');
                    const away = competitors.find(c => c.homeAway === 'away');
                    if (!home || !away) continue;

                    const hRawName = home.team?.displayName || home.team?.name || '';
                    const aRawName = away.team?.displayName || away.team?.name || '';
                    const hName = normalizeTeam(hRawName);
                    const aName = normalizeTeam(aRawName);

                    let hScore = Number(home.score ?? 0);
                    let aScore = Number(away.score ?? 0);
                    let htHome = null;
                    let htAway = null;

                    if (Array.isArray(home.linescores) && Array.isArray(away.linescores) && home.linescores.length >= 2 && away.linescores.length >= 2) {
                        htHome = Number(home.linescores[0]?.value ?? 0);
                        htAway = Number(away.linescores[0]?.value ?? 0);
                        const shHome = Number(home.linescores[1]?.value ?? 0);
                        const shAway = Number(away.linescores[1]?.value ?? 0);
                        hScore = htHome + shHome;
                        aScore = htAway + shAway;
                    } else if (Array.isArray(home.linescores) && home.linescores.length === 1 && Array.isArray(away.linescores) && away.linescores.length === 1) {
                        htHome = Number(home.linescores[0]?.value ?? 0);
                        htAway = Number(away.linescores[0]?.value ?? 0);
                    }

                    const homeCorners = extractStatValue(home.statistics, ['woncorners', 'cornerkicks', 'corners']);
                    const awayCorners = extractStatValue(away.statistics, ['woncorners', 'cornerkicks', 'corners']);
                    const homeRed = extractStatValue(home.statistics, ['redcards', 'red card']);
                    const awayRed = extractStatValue(away.statistics, ['redcards', 'red card']);
                    const homeYellow = extractStatValue(home.statistics, ['yellowcards', 'yellow card']);
                    const awayYellow = extractStatValue(away.statistics, ['yellowcards', 'yellow card']);

                    const state = ev?.status?.type?.state;
                    const completed = ev?.status?.type?.completed === true || state === 'post';
                    const periodNum = Number(ev?.status?.period || 0);
                    const statusDetail = String(ev?.status?.type?.shortDetail || ev?.status?.type?.name || '').toLowerCase();
                    const firstHalfCompleted =
                        completed ||
                        periodNum >= 2 ||
                        statusDetail.includes('ht') ||
                        statusDetail.includes('half') ||
                        (Array.isArray(home.linescores) && home.linescores.length >= 2);

                    scoreMap[`${hName}_${aName}`] = {
                        eventId: ev.id,
                        homeName: hRawName,
                        awayName: aRawName,
                        homeTeamId: home.team?.id,
                        awayTeamId: away.team?.id,
                        homeScore: hScore,
                        awayScore: aScore,
                        htHome,
                        htAway,
                        firstHalfCompleted,
                        homeCorners,
                        awayCorners,
                        htHomeCorners: null,
                        htAwayCorners: null,
                        shHomeCorners: null,
                        shAwayCorners: null,
                        homeRed,
                        awayRed,
                        homeYellow,
                        awayYellow,
                        goalEvents: [],
                        scorers: [],
                        firstGoalTeam: null,
                        lastGoalTeam: null,
                        firstCornerTeam: null,
                        lastCornerTeam: null,
                        scoreStr: state === 'pre' ? '-:-' : `${hScore}:${aScore}`,
                        state,
                        completed
                    };
                }
            })
        );
    } catch (e) {}
    scoreMap._sofaScheduleCache = sofaScheduleCache;
    return scoreMap;
};

const enrichMatchSummaryStats = async (matchObj) => {
    if (!matchObj || !matchObj.eventId || matchObj._enriched) return matchObj;
    matchObj._enriched = true;
    try {
        const res = await axios.get(
            `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${matchObj.eventId}`,
            { timeout: 4500 }
        ).catch(() => null);

        const data = res?.data;
        if (!data) return matchObj;

        const boxTeams = data?.boxscore?.teams || [];
        if (boxTeams.length >= 2) {
            const hBox = boxTeams.find(t => String(t.team?.id) === String(matchObj.homeTeamId)) || boxTeams[0];
            const aBox = boxTeams.find(t => String(t.team?.id) === String(matchObj.homeTeamId) ? false : String(t.team?.id) === String(matchObj.awayTeamId)) || boxTeams[1];

            const hC = extractStatValue(hBox?.statistics, ['woncorners', 'cornerkicks', 'corners', 'corner kicks']);
            const aC = extractStatValue(aBox?.statistics, ['woncorners', 'cornerkicks', 'corners', 'corner kicks']);
            if (hC !== null && aC !== null) {
                matchObj.homeCorners = hC;
                matchObj.awayCorners = aC;
            }

            const hR = extractStatValue(hBox?.statistics, ['redcards', 'red cards']);
            const aR = extractStatValue(aBox?.statistics, ['redcards', 'red cards']);
            if (hR !== null && aR !== null) {
                matchObj.homeRed = hR;
                matchObj.awayRed = aR;
            }

            const hY = extractStatValue(hBox?.statistics, ['yellowcards', 'yellow cards']);
            const aY = extractStatValue(aBox?.statistics, ['yellowcards', 'yellow cards']);
            if (hY !== null && aY !== null) {
                matchObj.homeYellow = hY;
                matchObj.awayYellow = aY;
            }
        }

        const headerComp = data?.header?.competitions?.[0];
        if (headerComp) {
            const comps = headerComp.competitors || [];
            const hComp = comps.find(c => c.homeAway === 'home');
            const aComp = comps.find(c => c.homeAway === 'away');
            if (hComp && aComp && Array.isArray(hComp.linescores) && Array.isArray(aComp.linescores)) {
                if (hComp.linescores.length >= 1 && aComp.linescores.length >= 1) {
                    matchObj.htHome = Number(hComp.linescores[0]?.value ?? hComp.linescores[0]?.displayValue ?? 0);
                    matchObj.htAway = Number(aComp.linescores[0]?.value ?? aComp.linescores[0]?.displayValue ?? 0);
                }
                if (hComp.linescores.length >= 2 && aComp.linescores.length >= 2) {
                    const shH = Number(hComp.linescores[1]?.value ?? hComp.linescores[1]?.displayValue ?? 0);
                    const shA = Number(aComp.linescores[1]?.value ?? aComp.linescores[1]?.displayValue ?? 0);
                    matchObj.homeScore = matchObj.htHome + shH;
                    matchObj.awayScore = matchObj.htAway + shA;
                    matchObj.scoreStr = `${matchObj.homeScore}:${matchObj.awayScore}`;
                    matchObj.firstHalfCompleted = true;
                }
            }

            const details = headerComp.details || data?.keyEvents || [];
            const goalEvents = [];
            for (const d of details) {
                const isGoal = d.scoringPlay === true || (d.type?.text && d.type.text.toLowerCase().includes('goal') && !d.type.text.toLowerCase().includes('miss'));
                if (isGoal) {
                    const rawClock = String(d.clock?.displayValue || d.clock?.value || '90');
                    let minute = parseInt(rawClock.replace(/[^0-9]/g, ''), 10) || 45;
                    if (d.clock?.value && d.clock.value > 120) {
                        minute = Math.ceil(Number(d.clock.value) / 60);
                    }
                    const isFirstHalfEvent = d.period?.number === 1 || (!rawClock.includes('45+') && minute <= 45) || rawClock.startsWith('45+');
                    const effectiveMinute = isFirstHalfEvent ? Math.min(45, minute) : Math.max(46, minute);
                    const scorerName = (d.participants?.[0]?.athlete?.displayName || d.athletesInvolved?.[0]?.displayName || d.text || '').toLowerCase();
                    const teamId = d.team?.id;
                    const side = String(teamId) === String(matchObj.homeTeamId) ? 'home' : String(teamId) === String(matchObj.awayTeamId) ? 'away' : null;
                    if (minute <= 95) {
                        goalEvents.push({ minute: effectiveMinute, scorerName, side });
                    }
                }
            }
            if (goalEvents.length > 0) {
                matchObj.goalEvents = goalEvents;
                matchObj.scorers = goalEvents.map(g => g.scorerName).filter(Boolean);
                matchObj.firstGoalTeam = goalEvents[0].side;
                matchObj.lastGoalTeam = goalEvents[goalEvents.length - 1].side;
                if (matchObj.htHome === null || matchObj.htAway === null) {
                    matchObj.htHome = goalEvents.filter(g => g.side === 'home' && g.minute <= 45).length;
                    matchObj.htAway = goalEvents.filter(g => g.side === 'away' && g.minute <= 45).length;
                }
            }
        }

        const plays = data?.plays || data?.commentary || [];
        if (Array.isArray(plays) && plays.length > 0) {
            const cornerPlays = [];
            const hNorm = normalizeTeam(matchObj.homeName);
            const aNorm = normalizeTeam(matchObj.awayName);
            for (const p of plays) {
                const txt = String(p.text || p.shortText || '').toLowerCase();
                if (txt.includes('corner,')) {
                    const cleanTxt = normalizeTeam(txt);
                    let side = null;
                    if (p.team?.id) {
                        side = String(p.team.id) === String(matchObj.homeTeamId) ? 'home' : String(p.team.id) === String(matchObj.awayTeamId) ? 'away' : null;
                    } else if (hNorm && cleanTxt.includes(hNorm)) {
                        side = 'home';
                    } else if (aNorm && cleanTxt.includes(aNorm)) {
                        side = 'away';
                    }
                    if (side) cornerPlays.push(side);
                }
            }
            if (cornerPlays.length > 0) {
                matchObj.firstCornerTeam = cornerPlays[0];
                matchObj.lastCornerTeam = cornerPlays[cornerPlays.length - 1];
            }
        }
    } catch (e) {}
    return matchObj;
};

const mergeMatchStats = (primary, secondary) => {
    if (!primary) return secondary;
    if (!secondary) return primary;
    return {
        ...primary,
        homeScore: primary.scoreStr !== '-:-' ? primary.homeScore : secondary.homeScore,
        awayScore: primary.scoreStr !== '-:-' ? primary.awayScore : secondary.awayScore,
        scoreStr: primary.scoreStr !== '-:-' ? primary.scoreStr : secondary.scoreStr,
        completed: primary.completed || secondary.completed,
        firstHalfCompleted: Boolean(primary.firstHalfCompleted || secondary.firstHalfCompleted || primary.completed || secondary.completed),
        htHome: primary.htHome ?? secondary.htHome,
        htAway: primary.htAway ?? secondary.htAway,
        homeCorners: primary.homeCorners ?? secondary.homeCorners,
        awayCorners: primary.awayCorners ?? secondary.awayCorners,
        htHomeCorners: primary.htHomeCorners ?? secondary.htHomeCorners,
        htAwayCorners: primary.htAwayCorners ?? secondary.htAwayCorners,
        shHomeCorners: primary.shHomeCorners ?? secondary.shHomeCorners,
        shAwayCorners: primary.shAwayCorners ?? secondary.shAwayCorners,
        homeRed: primary.homeRed ?? secondary.homeRed,
        awayRed: primary.awayRed ?? secondary.awayRed,
        homeYellow: primary.homeYellow ?? secondary.homeYellow,
        awayYellow: primary.awayYellow ?? secondary.awayYellow,
        goalEvents: (primary.goalEvents && primary.goalEvents.length > 0) ? primary.goalEvents : (secondary.goalEvents || []),
        scorers: (primary.scorers && primary.scorers.length > 0) ? primary.scorers : (secondary.scorers || []),
        firstGoalTeam: primary.firstGoalTeam ?? secondary.firstGoalTeam,
        lastGoalTeam: primary.lastGoalTeam ?? secondary.lastGoalTeam,
        firstCornerTeam: primary.firstCornerTeam ?? secondary.firstCornerTeam,
        lastCornerTeam: primary.lastCornerTeam ?? secondary.lastCornerTeam
    };
};

const parseScorePairFromText = (rawText) => {
    if (!rawText) return null;
    const str = String(rawText);
    const htMatch = str.match(/1H\s*(\d+)\s*[:\-]\s*(\d+)/i) || str.match(/HT\s*(\d+)\s*[:\-]\s*(\d+)/i);
    const ftMatch = str.match(/FT\s*(\d+)\s*[:\-]\s*(\d+)/i) || str.match(/^(\d+)\s*[:\-]\s*(\d+)$/);
    if (!htMatch && !ftMatch) return null;
    return {
        htHome: htMatch ? Number(htMatch[1]) : null,
        htAway: htMatch ? Number(htMatch[2]) : null,
        homeScore: ftMatch ? Number(ftMatch[1]) : (htMatch ? Number(htMatch[1]) : 0),
        awayScore: ftMatch ? Number(ftMatch[2]) : (htMatch ? Number(htMatch[2]) : 0),
        hasFT: Boolean(ftMatch),
        hasHT: Boolean(htMatch)
    };
};

const findMatchStatsForItem = async (item, ticket, scoreMap) => {
    const teams = String(item.match_info || '').split(/\s+vs\.?\s+|\s+-\s+/i);
    const homeTeam = (teams[0] || item.home_team || '').trim();
    const awayTeam = (teams[1] || item.away_team || '').trim();
    const { mId, mLower } = resolveMarketDetails(item);
    const needsHalfCorners = mLower.includes('corner') && (mLower.includes('1st half') || mLower.includes('first half') || mLower.includes('2nd half') || mLower.includes('second half'));
    const needsHalfScore =
        ['3', '6', '7', '9', '11', '13', '22', '26', '32', '34', '35', '36', '37', '39'].includes(mId) ||
        mLower.includes('half') ||
        mLower.includes('ht/ft');

    let resultData = await fetchApiFootballFixture(item.fixture_id);

    if ((!resultData || needsHalfCorners || (needsHalfScore && (resultData.htHome === null || resultData.htAway === null))) && homeTeam && awayTeam) {
        for (const [key, val] of Object.entries(scoreMap)) {
            if (key === '_sofaScheduleCache') continue;
            if (teamsMatch(homeTeam, val.homeName) && teamsMatch(awayTeam, val.awayName)) {
                const espnData = await enrichMatchSummaryStats(val);
                resultData = mergeMatchStats(resultData, espnData);
                break;
            }
        }
    }

    const missingCriticalStats =
        !resultData ||
        resultData.scoreStr === '-:-' ||
        (mLower.includes('corner') && (resultData.homeCorners === null || resultData.awayCorners === null)) ||
        (needsHalfCorners && (resultData.htHomeCorners === null || resultData.shHomeCorners === null)) ||
        (needsHalfScore && (resultData.htHome === null || resultData.htAway === null));

    if (missingCriticalStats && homeTeam && awayTeam) {
        const refTime = new Date(item.commence_time || ticket?.created_at || Date.now()).getTime();
        const sofaData = await fetchSofaScoreForItem(homeTeam, awayTeam, refTime, scoreMap._sofaScheduleCache);
        if (sofaData) {
            resultData = mergeMatchStats(sofaData, resultData);
        }
    }

    if (resultData) return resultData;

    const parsedSavedScore = parseScorePairFromText(item.score);
    if (parsedSavedScore) {
        return {
            homeScore: parsedSavedScore.homeScore,
            awayScore: parsedSavedScore.awayScore,
            htHome: parsedSavedScore.htHome,
            htAway: parsedSavedScore.htAway,
            firstHalfCompleted: parsedSavedScore.hasHT || parsedSavedScore.hasFT,
            homeCorners: null,
            awayCorners: null,
            htHomeCorners: null,
            htAwayCorners: null,
            shHomeCorners: null,
            shAwayCorners: null,
            homeRed: null,
            awayRed: null,
            homeYellow: null,
            awayYellow: null,
            goalEvents: [],
            scorers: [],
            firstGoalTeam: null,
            lastGoalTeam: null,
            firstCornerTeam: null,
            lastCornerTeam: null,
            scoreStr: `${parsedSavedScore.homeScore}:${parsedSavedScore.awayScore}`,
            completed: parsedSavedScore.hasFT
        };
    }

    return null;
};

// ==============================================================================
// ንዑስ የህግ ማረጋገጫዎች (Universal Pick Evaluators)
// ==============================================================================

const eval1X2Pick = (pickStr, H, A, homeTeam, awayTeam) => {
    const p = String(pickStr || '').trim().toLowerCase();
    if (['1', 'w1', 'home'].includes(p) || teamsMatch(p, homeTeam)) return H > A;
    if (['2', 'w2', 'away'].includes(p) || teamsMatch(p, awayTeam)) return A > H;
    if (['x', 'draw', 'tie', 'equal'].includes(p)) return H === A;
    return null;
};

const evalDCPick = (pickStr, H, A, homeTeam, awayTeam) => {
    const p = String(pickStr || '').trim().toLowerCase();
    if (p === '1x' || p === 'home/draw' || p === 'home or draw' || (p.includes('home') && p.includes('draw'))) return H >= A;
    if (p === 'x2' || p === 'draw/away' || p === 'draw or away' || (p.includes('draw') && p.includes('away'))) return A >= H;
    if (p === '12' || p === 'home/away' || p === 'home or away' || (p.includes('home') && p.includes('away'))) return H !== A;
    if (homeTeam && p.includes(homeTeam.toLowerCase()) && p.includes('draw')) return H >= A;
    if (awayTeam && p.includes(awayTeam.toLowerCase()) && p.includes('draw')) return A >= H;
    if (homeTeam && awayTeam && p.includes(homeTeam.toLowerCase()) && p.includes(awayTeam.toLowerCase())) return H !== A;
    return null;
};

const evalHTFTPick = (pickRaw, htH, htA, H, A, homeTeam, awayTeam) => {
    const clean = String(pickRaw || '').trim();
    let partHT = null;
    let partFT = null;

    if (/[\/\-]/.test(clean)) {
        const parts = clean.split(/[\/\-]/).map(s => s.trim()).filter(Boolean);
        if (parts.length === 2) {
            partHT = parts[0];
            partFT = parts[1];
        }
    } else if (/^[12xX]{2}$/.test(clean)) {
        partHT = clean[0];
        partFT = clean[1];
    } else {
        const tokens = clean.split(/\s+/).filter(Boolean);
        if (tokens.length === 2) {
            partHT = tokens[0];
            partFT = tokens[1];
        }
    }

    if (partHT === null || partFT === null) return null;

    const evalPart = (token, gH, gA) =>
        eval1X2Pick(token, gH, gA, homeTeam, awayTeam) ?? evalDCPick(token, gH, gA, homeTeam, awayTeam);

    const rFT = evalPart(partFT, H, A);
    if (rFT === false) return false;

    if (htH !== null && htA !== null) {
        const rHT = evalPart(partHT, htH, htA);
        if (rHT !== null && rFT !== null) return rHT && rFT;
    }

    const pHT = String(partHT).toLowerCase();
    if ((pHT === '1' || pHT === 'home') && H === 0) return false;
    if ((pHT === '2' || pHT === 'away') && A === 0) return false;

    return null;
};

const evalBTTSPick = (pickStr, H, A) => {
    const p = String(pickStr || '').trim().toLowerCase();
    if (['yes', 'gg', 'btts - yes', 'both teams to score - yes', 'btts yes'].includes(p)) return H > 0 && A > 0;
    if (['no', 'ng', 'btts - no', 'both teams to score - no', 'btts no'].includes(p)) return H === 0 || A === 0;
    return null;
};

const evalOUPick = (pickStr, targetTotal) => {
    const p = String(pickStr || '').trim();
    const m = p.match(/(?:^|[\s\/(\-])(over|under|o|u|\+|\-)\s*\/?\s*\(?([\d.]+)\)?/i);
    if (!m) return null;
    const rawDir = m[1].toLowerCase();
    const line = parseFloat(m[2]);
    if (rawDir === 'over' || rawDir === 'o' || rawDir === '+') return targetTotal > line;
    if (rawDir === 'under' || rawDir === 'u' || rawDir === '-') return targetTotal < line;
    return null;
};

const parseOULineAndDir = (pickStr) => {
    const p = String(pickStr || '').trim();
    const m = p.match(/(?:^|[\s\/(\-])(over|under|o|u|\+|\-)\s*\/?\s*\(?([\d.]+)\)?/i);
    if (!m) return null;
    const rawDir = m[1].toLowerCase();
    const line = parseFloat(m[2]);
    const dir = (rawDir === 'over' || rawDir === 'o' || rawDir === '+') ? 'over' : 'under';
    return { dir, line };
};

const evaluateRangeOrExactPick = (pickStr, targetValue) => {
    const p = String(pickStr || '').trim().toLowerCase();
    if (p === 'no goal' || p === 'none' || p === '0' || p === 'no goals' || p === 'no corner' || p === 'no corners') {
        return targetValue === 0;
    }
    const rangeMatch = p.match(/(\d+)\s*[\-–to]+\s*(\d+)/);
    if (rangeMatch) {
        const min = parseInt(rangeMatch[1], 10);
        const max = parseInt(rangeMatch[2], 10);
        return targetValue >= min && targetValue <= max;
    }
    const plusMatch = p.match(/(\d+)\s*\+/);
    if (plusMatch) {
        return targetValue >= parseInt(plusMatch[1], 10);
    }
    const exactMatch = p.match(/^(?:exact\s*)?(\d+)(?:\s*goals?|\s*corners?)?$/);
    if (exactMatch) {
        return targetValue === parseInt(exactMatch[1], 10);
    }
    const ou = evalOUPick(pickStr, targetValue);
    if (ou !== null) return ou;
    return null;
};

const evaluateComboSelection = (mId, mLower, pickRaw, H, A, homeTeam, awayTeam) => {
    const total = H + A;
    const p = String(pickRaw || '').trim();

    const decimalMatch = p.match(/(\d+\.\d+)/);
    const lineVal = decimalMatch ? parseFloat(decimalMatch[1]) : 2.5;

    const isOver = /(?:^|[\s\/&\-])(over|o)(?:[\s\/&\-\d(]|$)/i.test(p);
    const isUnder = /(?:^|[\s\/&\-])(under|u)(?:[\s\/&\-\d(]|$)/i.test(p);
    const hasOU = isOver || isUnder;
    const ouWon = isOver ? total > lineVal : isUnder ? total < lineVal : null;

    const hasYes = /(?:^|[\s\/&\-])(yes|gg)(?:[\s\/&\-\d]|$)/i.test(p);
    const hasNo = /(?:^|[\s\/&\-])(no|ng)(?:[\s\/&\-\d]|$)/i.test(p);
    const hasBTTS = hasYes || hasNo;
    const bttsWon = hasYes ? (H > 0 && A > 0) : hasNo ? (H === 0 || A === 0) : null;

    if (mId === '49' || (mLower.includes('total') && mLower.includes('both teams')) || (hasOU && hasBTTS)) {
        if (ouWon !== null && bttsWon !== null) {
            return ouWon && bttsWon;
        }
    }

    if (mId === '33' || (mLower.includes('double chance') && mLower.includes('both teams'))) {
        let dcWon = null;
        if (/1x|home\s*\/\s*draw|home\s+or\s+draw/i.test(p)) dcWon = H >= A;
        else if (/x2|draw\s*\/\s*away|draw\s+or\s+away/i.test(p)) dcWon = A >= H;
        else if (/12|home\s*\/\s*away|home\s+or\s+away/i.test(p)) dcWon = H !== A;

        if (dcWon !== null && bttsWon !== null) {
            return dcWon && bttsWon;
        }
    }

    if (mId === '25' || (mLower.includes('1x2') && mLower.includes('total')) || (hasOU && /[\/&\-]/.test(p))) {
        const teamToken = p
            .replace(/(?:over|under)\s*\(?[\d.]+\)?/gi, '')
            .replace(/\d+\.\d+/g, '')
            .replace(/(?:^|[\s\/&\-])(?:o|u)(?:[\s\/&\-]|$)/gi, ' ')
            .replace(/[\/&\-\(\)]+/g, ' ')
            .trim();

        const r1 = eval1X2Pick(teamToken, H, A, homeTeam, awayTeam) ?? evalDCPick(teamToken, H, A, homeTeam, awayTeam);
        if (r1 !== null && ouWon !== null) {
            return r1 && ouWon;
        }
    }

    if (mId === '24' || (mLower.includes('1x2') && mLower.includes('both teams')) || (hasBTTS && /[\/&\-]/.test(p))) {
        const teamToken = p
            .replace(/\b(yes|no|gg|ng)\b/gi, '')
            .replace(/[\/&\-\s]+/g, ' ')
            .trim();

        const r1 = eval1X2Pick(teamToken, H, A, homeTeam, awayTeam) ?? evalDCPick(teamToken, H, A, homeTeam, awayTeam);
        if (r1 !== null && bttsWon !== null) {
            return r1 && bttsWon;
        }
    }

    return null;
};

// ==============================================================================
// 🌟 ዋናው የሁሉም ማርኬቶች ማረጋገጫ ተግባር (All-Markets Evaluator) 🌟
// ==============================================================================
const evaluateSingleLegAmharic = (item, matchData) => {
    const { mId, canonicalMarket, mLower } = resolveMarketDetails(item);
    const pickRaw = asText(item.odd_name);
    const pick = pickRaw.toLowerCase();
    const teams = String(item.match_info || '').split(/\s+vs\.?\s+|\s+-\s+/i);
    const homeTeam = (teams[0] || 'ባለሜዳ').trim();
    const awayTeam = (teams[1] || 'እንግዳ').trim();

    if (['postponed', 'cancelled', 'abandoned'].includes(item.match_status)) {
        return {
            item_id: item.id,
            match_info: item.match_info,
            liveScore: 'POSTPONED',
            aiStatus: 'postponed',
            explanationAmharic: `[${canonicalMarket}] ጨዋታው ስለተራዘመ ወይም ስለተሰረዘ በህጉ መሰረት ኦዱ በ 1.00 ይሰላል።`
        };
    }

    // 1. የኮርነር ማርኬቶች (ALL CORNER MARKETS)
    const isCornerMarket =
        ['85', '79', '295', '88', '86', '87', '89', '90'].includes(mId) ||
        mLower.includes('corner') ||
        pick.includes('corner');

    if (isCornerMarket) {
        const is1stHalfCorner = mLower.includes('1st half') || mLower.includes('first half') || pick.includes('1st half') || pick.includes('first half');
        const is2ndHalfCorner = mLower.includes('2nd half') || mLower.includes('second half') || pick.includes('2nd half') || pick.includes('second half');
        const isHomeCorner = mId === '89' || mLower.includes('home total corners') || mLower.includes('home corners') || mLower.includes('corners - home');
        const isAwayCorner = mId === '90' || mLower.includes('away total corners') || mLower.includes('away corners') || mLower.includes('corners - away');

        if (is1stHalfCorner || is2ndHalfCorner) {
            const halfLabel = is1stHalfCorner ? '1ኛ አጋማሽ' : '2ኛ አጋማሽ';
            const shortHalf = is1stHalfCorner ? '1H' : '2H';
            const hC = is1stHalfCorner ? matchData?.htHomeCorners : matchData?.shHomeCorners;
            const aC = is1stHalfCorner ? matchData?.htAwayCorners : matchData?.shAwayCorners;

            if (matchData && hC !== null && hC !== undefined && aC !== null && aC !== undefined) {
                const cTotal = hC + aC;
                const cornerScoreDisplay = `${shortHalf} ኮርነር ${hC}:${aC} (${cTotal})`;

                if (!matchData.completed && !(is1stHalfCorner && matchData.firstHalfCompleted)) {
                    return {
                        item_id: item.id,
                        match_info: item.match_info,
                        liveScore: cornerScoreDisplay,
                        aiStatus: 'pending',
                        explanationAmharic: `[${canonicalMarket}] ጨዋታው በመካሄድ ላይ ነው (${halfLabel} ኮርነር ${hC}:${aC}፣ ጠቅላላ ${cTotal})።`
                    };
                }

                let won = null;
                if (isHomeCorner) {
                    won = evaluateRangeOrExactPick(pickRaw, hC);
                } else if (isAwayCorner) {
                    won = evaluateRangeOrExactPick(pickRaw, aC);
                } else if (mLower.includes('1x2') || mLower.includes('most') || mLower.includes('winner')) {
                    won = eval1X2Pick(pickRaw, hC, aC, homeTeam, awayTeam) ?? evalDCPick(pickRaw, hC, aC, homeTeam, awayTeam);
                } else if (mLower.includes('odd/even')) {
                    if (pick.includes('odd')) won = cTotal % 2 === 1;
                    else if (pick.includes('even')) won = cTotal % 2 === 0;
                } else {
                    won = evaluateRangeOrExactPick(pickRaw, cTotal);
                }

                if (won !== null) {
                    return {
                        item_id: item.id,
                        match_info: item.match_info,
                        liveScore: cornerScoreDisplay,
                        aiStatus: won ? 'won' : 'lost',
                        explanationAmharic: `[${canonicalMarket}] በ${halfLabel} ጠቅላላ ${cTotal} ኮርነሮች (${homeTeam} ${hC} : ${awayTeam} ${aC}) ተመዝግበዋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
                    };
                }
            }

            if (matchData && matchData.completed && matchData.homeCorners !== null && matchData.awayCorners !== null) {
                const ftTarget = isHomeCorner
                    ? matchData.homeCorners
                    : isAwayCorner
                        ? matchData.awayCorners
                        : (matchData.homeCorners + matchData.awayCorners);
                const ouParsed = parseOULineAndDir(pickRaw);
                if (ouParsed) {
                    if (ouParsed.dir === 'over' && ftTarget <= ouParsed.line) {
                        return {
                            item_id: item.id,
                            match_info: item.match_info,
                            liveScore: `FT ኮርነር ${matchData.homeCorners}:${matchData.awayCorners}`,
                            aiStatus: 'lost',
                            explanationAmharic: `[${canonicalMarket}] በሙሉው ጨዋታ የተመዘገበው ኮርነር (${ftTarget}) ከተመረጠው (${pickRaw}) ያነሰ ስለሆነ ተሸንፏል።`
                        };
                    }
                    if (ouParsed.dir === 'under' && ftTarget < ouParsed.line) {
                        return {
                            item_id: item.id,
                            match_info: item.match_info,
                            liveScore: `FT ኮርነር ${matchData.homeCorners}:${matchData.awayCorners}`,
                            aiStatus: 'won',
                            explanationAmharic: `[${canonicalMarket}] በሙሉው ጨዋታ የተመዘገበው ኮርነር (${ftTarget}) ከተመረጠው (${pickRaw}) በታች ስለሆነ አሸንፏል።`
                        };
                    }
                }
            }

            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: matchData?.scoreStr && matchData.scoreStr !== '-:-' ? `ጎል ${matchData.scoreStr} (${shortHalf} ኮርነር -:-)` : 'ኮርነር -:-',
                aiStatus: 'pending',
                explanationAmharic: `[${canonicalMarket} - ${pickRaw}] የ${halfLabel} የኮርነር ቁጥር ዳታ ገና ስላልደረሰ በጎል ብዛት አይሰላም።`
            };
        }

        if (!matchData || matchData.homeCorners === null || matchData.awayCorners === null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: matchData?.scoreStr && matchData.scoreStr !== '-:-' ? `ጎል ${matchData.scoreStr} (ኮርነር -:-)` : 'ኮርነር -:-',
                aiStatus: 'pending',
                explanationAmharic: `[${canonicalMarket} - ${pickRaw}] ይህ የኮርነር ውርርድ ነው። የጨዋታው ትክክለኛ የኮርነር (Corner) ቁጥር ዳታ ገና ስላልደረሰ በጎል ብዛት አይሰላም።`
            };
        }

        const cH = matchData.homeCorners;
        const cA = matchData.awayCorners;
        const cTotal = cH + cA;
        const cornerScoreDisplay = `ኮርነር ${cH}:${cA} (${cTotal})`;

        if (!matchData.completed) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: cornerScoreDisplay,
                aiStatus: 'pending',
                explanationAmharic: `[${canonicalMarket}] ጨዋታው በመካሄድ ላይ ነው (አሁን ያለው ኮርነር ${cH}:${cA}፣ ጠቅላላ ${cTotal})።`
            };
        }

        let won = null;
        if (mId === '86' || mLower.includes('last corner') || mId === '87' || mLower.includes('first corner')) {
            if (cTotal === 0) {
                won = pick.includes('none') || pick.includes('no corner') || pick === 'x';
            } else if (cH > 0 && cA === 0) {
                won = eval1X2Pick(pickRaw, 1, 0, homeTeam, awayTeam);
            } else if (cA > 0 && cH === 0) {
                won = eval1X2Pick(pickRaw, 0, 1, homeTeam, awayTeam);
            } else {
                const targetCornerTeam = (mId === '87' || mLower.includes('first corner')) ? matchData.firstCornerTeam : matchData.lastCornerTeam;
                if (targetCornerTeam === 'home') won = eval1X2Pick(pickRaw, 1, 0, homeTeam, awayTeam);
                else if (targetCornerTeam === 'away') won = eval1X2Pick(pickRaw, 0, 1, homeTeam, awayTeam);
            }
        } else if (mId === '79' || mLower.includes('corner 1x2') || mLower.includes('most corners')) {
            won = eval1X2Pick(pickRaw, cH, cA, homeTeam, awayTeam) ?? evalDCPick(pickRaw, cH, cA, homeTeam, awayTeam);
        } else if (mId === '88' || mLower.includes('odd/even corner')) {
            if (pick.includes('odd')) won = cTotal % 2 === 1;
            else if (pick.includes('even')) won = cTotal % 2 === 0;
        } else if (isHomeCorner) {
            won = evaluateRangeOrExactPick(pickRaw, cH);
        } else if (isAwayCorner) {
            won = evaluateRangeOrExactPick(pickRaw, cA);
        } else {
            won = evaluateRangeOrExactPick(pickRaw, cTotal);
        }

        if (won === null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: cornerScoreDisplay,
                aiStatus: 'pending',
                explanationAmharic: `[${canonicalMarket} - ${pickRaw}] የኮርነር ውጤት ${cH}:${cA} (ጠቅላላ ${cTotal} ኮርነር) ነው።`
            };
        }

        return {
            item_id: item.id,
            match_info: item.match_info,
            liveScore: cornerScoreDisplay,
            aiStatus: won ? 'won' : 'lost',
            explanationAmharic: `[${canonicalMarket}] በጨዋታው ጠቅላላ ${cTotal} ኮርነሮች (${homeTeam} ${cH} : ${awayTeam} ${cA}) ተመዝግበዋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
        };
    }

    // 2. የካርድ / ቀይ ካርድ ማርኬቶች (CARD / SENDING OFF MARKETS)
    const isCardMarket = ['83', '80'].includes(mId) || mLower.includes('sending off') || mLower.includes('card') || pick.includes('card');
    if (isCardMarket) {
        if (!matchData || !matchData.completed || matchData.homeRed === null || matchData.awayRed === null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: 'ካርድ -:-',
                aiStatus: 'pending',
                explanationAmharic: `[${canonicalMarket} - ${pickRaw}] የጨዋታው የካርድ መረጃ ገና አልተጠናቀቀም።`
            };
        }

        const totalRed = matchData.homeRed + matchData.awayRed;
        const totalYellow = (matchData.homeYellow ?? 0) + (matchData.awayYellow ?? 0);
        const totalCards = totalYellow + totalRed;

        let won = null;
        if (mId === '83' || mLower.includes('sending off') || ['yes', 'no', 'gg', 'ng'].includes(pick)) {
            if (['yes', 'gg'].includes(pick)) won = totalRed > 0;
            else if (['no', 'ng'].includes(pick)) won = totalRed === 0;
            if (won !== null) {
                return {
                    item_id: item.id,
                    match_info: item.match_info,
                    liveScore: `ቀይ ካርድ: ${totalRed}`,
                    aiStatus: won ? 'won' : 'lost',
                    explanationAmharic: `[${canonicalMarket}] በጨዋታው ${totalRed} ቀይ ካርድ ተመዝግቧል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
                };
            }
        } else if (matchData.homeYellow !== null && matchData.awayYellow !== null) {
            won = evaluateRangeOrExactPick(pickRaw, totalCards);
            if (won !== null) {
                return {
                    item_id: item.id,
                    match_info: item.match_info,
                    liveScore: `ካርድ: ${totalCards} (ቢጫ ${totalYellow}, ቀይ ${totalRed})`,
                    aiStatus: won ? 'won' : 'lost',
                    explanationAmharic: `[${canonicalMarket}] በጨዋታው ጠቅላላ ${totalCards} ካርዶች ተመዝግበዋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
                };
            }
        }
    }

    if (!matchData || matchData.scoreStr === '-:-') {
        return {
            item_id: item.id,
            match_info: item.match_info,
            liveScore: '-:-',
            aiStatus: 'pending',
            explanationAmharic: `[${canonicalMarket} - ${pickRaw}] ጨዋታው ገና አልተጠናቀቀም ወይም የ90 ደቂቃ ውጤት አልደረሰም።`
        };
    }

    const H = matchData.homeScore;
    const A = matchData.awayScore;
    const total = H + A;
    const scoreStr = `${H}:${A}`;

    let htH = matchData.htHome;
    let htA = matchData.htAway;
    if ((htH === null || htA === null) && matchData.completed && H === 0 && A === 0) {
        htH = 0;
        htA = 0;
    } else if ((htH === null || htA === null) && matchData.completed && Array.isArray(matchData.goalEvents) && matchData.goalEvents.length === total && total > 0) {
        htH = matchData.goalEvents.filter(g => g.side === 'home' && g.minute <= 45).length;
        htA = matchData.goalEvents.filter(g => g.side === 'away' && g.minute <= 45).length;
    }

    const is1stHalfTotal = is1stHalfTotalMarket(mId, mLower);
    const is2ndHalfTotal = is2ndHalfTotalMarket(mId, mLower);
    const is1stHalfOnlyMarket =
        is1stHalfTotal ||
        ['13', '22', '32', '34'].includes(mId) ||
        mLower.includes('1st half result') ||
        mLower.includes('first half winner') ||
        mLower.includes('1st half double chance') ||
        (mLower.includes('1st half') && mLower.includes('both teams')) ||
        mLower.includes('1st half odd/even');

    if (!matchData.completed && !(is1stHalfOnlyMarket && matchData.firstHalfCompleted && htH !== null && htA !== null)) {
        return {
            item_id: item.id,
            match_info: item.match_info,
            liveScore: (htH !== null && htA !== null) ? `1H ${htH}:${htA} (Live ${scoreStr})` : scoreStr,
            aiStatus: 'pending',
            explanationAmharic: `[${canonicalMarket}] ጨዋታው በመካሄድ ላይ ነው (አሁን ያለው ውጤት ${scoreStr})።`
        };
    }

    // 3. 10 ደቂቃ ውጤት (Market 54: 10 Minutes - 1X2)
    if (mId === '54' || mLower.includes('10 minutes')) {
        let h10 = null;
        let a10 = null;
        if (H === 0 && A === 0) {
            h10 = 0;
            a10 = 0;
        } else if (Array.isArray(matchData.goalEvents) && matchData.goalEvents.length === total) {
            h10 = matchData.goalEvents.filter(g => g.side === 'home' && g.minute <= 10).length;
            a10 = matchData.goalEvents.filter(g => g.side === 'away' && g.minute <= 10).length;
        }

        if (h10 !== null && a10 !== null) {
            const won = eval1X2Pick(pickRaw, h10, a10, homeTeam, awayTeam) ?? evalDCPick(pickRaw, h10, a10, homeTeam, awayTeam) ?? evalOUPick(pickRaw, h10 + a10);
            if (won !== null) {
                return {
                    item_id: item.id,
                    match_info: item.match_info,
                    liveScore: `10' (${h10}:${a10}) / FT ${scoreStr}`,
                    aiStatus: won ? 'won' : 'lost',
                    explanationAmharic: `[10 Minutes - 1X2] በመጀመሪያዎቹ 10 ደቂቃዎች ውጤቱ ${h10}:${a10} ነበር። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
                };
            }
        }
        return {
            item_id: item.id,
            match_info: item.match_info,
            liveScore: scoreStr,
            aiStatus: 'pending',
            explanationAmharic: `[10 Minutes - 1X2] የመጀመሪያዎቹ 10 ደቂቃዎች የጎል ደቂቃ ዝርዝር በመጠባበቅ ላይ ነው።`
        };
    }

    // 4. የ1ኛ አጋማሽ፣ የ2ኛ አጋማሽ፣ HT/FT እና Highest Scoring Half ማርኬቶች
    const isHalfMarket =
        is1stHalfTotal ||
        is2ndHalfTotal ||
        ['3', '6', '7', '9', '11', '13', '22', '26', '32', '34', '35', '36', '37', '39'].includes(mId) ||
        mLower.includes('1st half') ||
        mLower.includes('first half') ||
        mLower.includes('2nd half') ||
        mLower.includes('second half') ||
        mLower.includes('halftime') ||
        mLower.includes('ht/ft') ||
        mLower.includes('highest scoring half') ||
        mLower.includes('both halves') ||
        mLower.includes('either half');

    if (isHalfMarket) {
        if (mId === '7' || mLower.includes('halftime/fulltime') || mLower.includes('ht/ft')) {
            const earlyHTFT = evalHTFTPick(pickRaw, htH, htA, H, A, homeTeam, awayTeam);
            if (earlyHTFT !== null) {
                const label = (htH !== null && htA !== null)
                    ? `1H ${htH}:${htA} / FT ${scoreStr}`
                    : `FT ${scoreStr}`;
                return {
                    item_id: item.id,
                    match_info: item.match_info,
                    liveScore: label,
                    aiStatus: earlyHTFT ? 'won' : 'lost',
                    explanationAmharic: (htH !== null && htA !== null)
                        ? `[${canonicalMarket}] 1ኛ አጋማሽ ${htH}:${htA}፣ ሙሉ ሰዓት ${scoreStr} ተጠናቋል። ምርጫዎ (${pickRaw}) ${earlyHTFT ? 'አሸንፏል' : 'ተሸንፏል'}።`
                        : `[${canonicalMarket}] ሙሉ ሰዓት ${scoreStr} ስለተጠናቀቀ ምርጫዎ (${pickRaw}) ተሸንፏል።`
                };
            }
        }

        // የ1ኛ አጋማሽ ውጤት ባይመጣም እንኳ ከሙሉ ሰዓት (FT) ውጤት በሂሳብ ህግ መወሰን የሚችሉትን ወዲያውኑ መወሰን
        if ((htH === null || htA === null) && matchData.completed && (is1stHalfTotal || is2ndHalfTotal)) {
            const ftTarget = mLower.includes('home') ? H : mLower.includes('away') ? A : total;
            const ouParsed = parseOULineAndDir(pickRaw);
            if (ouParsed) {
                if (ouParsed.dir === 'over' && ftTarget <= ouParsed.line) {
                    return {
                        item_id: item.id,
                        match_info: item.match_info,
                        liveScore: `FT ${scoreStr}`,
                        aiStatus: 'lost',
                        explanationAmharic: `[${canonicalMarket}] በሙሉው ጨዋታ የተቆጠረው ጎል (${ftTarget}) ከተመረጠው (${pickRaw}) ያነሰ ስለሆነ ተሸንፏል።`
                    };
                }
                if (ouParsed.dir === 'under' && ftTarget < ouParsed.line) {
                    return {
                        item_id: item.id,
                        match_info: item.match_info,
                        liveScore: `FT ${scoreStr}`,
                        aiStatus: 'won',
                        explanationAmharic: `[${canonicalMarket}] በሙሉው ጨዋታ የተቆጠረው ጎል (${ftTarget}) ከተመረጠው (${pickRaw}) በታች ስለሆነ አሸንፏል።`
                    };
                }
            }
        }

        if (htH === null || htA === null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: `FT ${scoreStr} (HT -:-)`,
                aiStatus: 'pending',
                explanationAmharic: `[${canonicalMarket} - ${pickRaw}] የመጀመሪያው አጋማሽ (1st Half) ውጤት መረጃ ስላልተገኘ በሙሉ ሰዓት ውጤት አይሰላም።`
            };
        }

        const htTotal = htH + htA;
        const shH = Math.max(0, H - htH);
        const shA = Math.max(0, A - htA);
        const shTotal = shH + shA;
        const halfScoreLabel = matchData.completed
            ? `1H ${htH}:${htA} / 2H ${shH}:${shA} (FT ${scoreStr})`
            : `1H ${htH}:${htA} (Live ${scoreStr})`;

        let won = null;
        if (is1stHalfTotal) {
            if (mLower.includes('home')) won = evaluateRangeOrExactPick(pickRaw, htH);
            else if (mLower.includes('away')) won = evaluateRangeOrExactPick(pickRaw, htA);
            else won = evaluateRangeOrExactPick(pickRaw, htTotal);
        } else if (is2ndHalfTotal) {
            if (mLower.includes('home')) won = evaluateRangeOrExactPick(pickRaw, shH);
            else if (mLower.includes('away')) won = evaluateRangeOrExactPick(pickRaw, shA);
            else won = evaluateRangeOrExactPick(pickRaw, shTotal);
        } else if (mId === '13' || mLower.includes('1st half result') || mLower.includes('first half winner') || mLower.includes('1st half - 1x2') || mLower.includes('1st half 1x2')) {
            won = eval1X2Pick(pickRaw, htH, htA, homeTeam, awayTeam);
        } else if (mId === '3' || mLower.includes('2nd half result') || mLower.includes('second half winner') || mLower.includes('2nd half - 1x2') || mLower.includes('2nd half 1x2')) {
            won = eval1X2Pick(pickRaw, shH, shA, homeTeam, awayTeam);
        } else if (mId === '32' || mLower.includes('1st half double chance') || mLower.includes('1st half - double chance')) {
            won = evalDCPick(pickRaw, htH, htA, homeTeam, awayTeam);
        } else if (mLower.includes('2nd half double chance') || mLower.includes('2nd half - double chance')) {
            won = evalDCPick(pickRaw, shH, shA, homeTeam, awayTeam);
        } else if (mId === '34' || (mLower.includes('1st half') && mLower.includes('both teams'))) {
            won = evalBTTSPick(pickRaw, htH, htA);
        } else if (mId === '26' || (mLower.includes('2nd half') && mLower.includes('both teams'))) {
            won = evalBTTSPick(pickRaw, shH, shA);
        } else if (mId === '22' || (mLower.includes('1st half') && mLower.includes('odd/even'))) {
            if (pick.includes('odd')) won = htTotal % 2 === 1;
            else if (pick.includes('even')) won = htTotal % 2 === 0;
        } else if (mLower.includes('2nd half') && mLower.includes('odd/even')) {
            if (pick.includes('odd')) won = shTotal % 2 === 1;
            else if (pick.includes('even')) won = shTotal % 2 === 0;
        } else if (mId === '7' || mLower.includes('halftime/fulltime') || mLower.includes('ht/ft')) {
            won = evalHTFTPick(pickRaw, htH, htA, H, A, homeTeam, awayTeam);
        } else if (mId === '11' || mLower.includes('highest scoring half')) {
            if (pick.includes('1st') || pick === '1') won = htTotal > shTotal;
            else if (pick.includes('2nd') || pick === '2') won = shTotal > htTotal;
            else if (pick.includes('equal') || pick.includes('draw') || pick.includes('tie') || pick === 'x') won = htTotal === shTotal;
        } else if (mId === '39' || mLower.includes('score in both halves')) {
            if (mLower.includes('home')) {
                if (['yes', 'gg'].includes(pick)) won = htH > 0 && shH > 0;
                else if (['no', 'ng'].includes(pick)) won = htH === 0 || shH === 0;
            } else if (mLower.includes('away')) {
                if (['yes', 'gg'].includes(pick)) won = htA > 0 && shA > 0;
                else if (['no', 'ng'].includes(pick)) won = htA === 0 || shA === 0;
            } else {
                if (['yes', 'gg'].includes(pick)) won = htTotal > 0 && shTotal > 0;
                else if (['no', 'ng'].includes(pick)) won = htTotal === 0 || shTotal === 0;
            }
        } else if (mId === '35' || mLower.includes('both halves over 1.5')) {
            if (['yes', 'gg'].includes(pick)) won = htTotal > 1.5 && shTotal > 1.5;
            else if (['no', 'ng'].includes(pick)) won = htTotal < 1.5 || shTotal < 1.5;
        } else if (mId === '36' || mLower.includes('win both halves')) {
            const homeWinsBoth = htH > htA && shH > shA;
            const awayWinsBoth = htA > htH && shA > shH;
            if (mLower.includes('home') || ['1', 'home'].includes(pick) || teamsMatch(pick, homeTeam)) {
                won = ['no', 'ng'].includes(pick) ? !homeWinsBoth : homeWinsBoth;
            } else if (mLower.includes('away') || ['2', 'away'].includes(pick) || teamsMatch(pick, awayTeam)) {
                won = ['no', 'ng'].includes(pick) ? !awayWinsBoth : awayWinsBoth;
            }
        } else if (mId === '37' || mLower.includes('win either half')) {
            const homeWinsEither = htH > htA || shH > shA;
            const awayWinsEither = htA > htH || shA > shH;
            if (mLower.includes('home') || ['1', 'home'].includes(pick) || teamsMatch(pick, homeTeam)) {
                won = ['no', 'ng'].includes(pick) ? !homeWinsEither : homeWinsEither;
            } else if (mLower.includes('away') || ['2', 'away'].includes(pick) || teamsMatch(pick, awayTeam)) {
                won = ['no', 'ng'].includes(pick) ? !awayWinsEither : awayWinsEither;
            }
        } else if (mLower.includes('1st half') || mLower.includes('first half')) {
            won = evaluateRangeOrExactPick(pickRaw, htTotal) ?? eval1X2Pick(pickRaw, htH, htA, homeTeam, awayTeam) ?? evalDCPick(pickRaw, htH, htA, homeTeam, awayTeam);
        } else if (mLower.includes('2nd half') || mLower.includes('second half')) {
            won = evaluateRangeOrExactPick(pickRaw, shTotal) ?? eval1X2Pick(pickRaw, shH, shA, homeTeam, awayTeam) ?? evalDCPick(pickRaw, shH, shA, homeTeam, awayTeam);
        }

        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: halfScoreLabel,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] 1ኛ አጋማሽ ${htH}:${htA} (ጠቅላላ ${htTotal} ጎል)፣ ሙሉ ሰዓት ${scoreStr} ተጠናቋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    // 5. ጥምር (COMBO) ማርኬቶች
    const isComboMarket =
        ['25', '24', '33', '49'].includes(mId) ||
        mLower.includes('&') ||
        (mLower.includes('result') && mLower.includes('total')) ||
        (mLower.includes('result') && mLower.includes('both teams')) ||
        (mLower.includes('double chance') && mLower.includes('both teams')) ||
        (mLower.includes('total') && mLower.includes('both teams')) ||
        /(?:^|[\s\/&\-])(?:over|under|o|u)\s*\/?\s*(?:yes|no|gg|ng)/i.test(pickRaw);

    if (isComboMarket) {
        const comboWon = evaluateComboSelection(mId, mLower, pickRaw, H, A, homeTeam, awayTeam);
        if (comboWon !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: comboWon ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ጨዋታው ${scoreStr} (ጠቅላላ ${total} ጎል) ተጠናቋል። ጥምር ምርጫዎ (${pickRaw}) ${comboWon ? 'ሁለቱንም ቅድመ-ሁኔታዎች ስላሟላ አሸንፏል' : 'አላሸነፈም'}።`
            };
        }
    }

    // 6. የተናጠል ቡድን ጎል እና ልዩ የጎል ማርኬቶች
    if (mId === '16' || mLower.includes('home total goals') || mLower.includes('total - home')) {
        const won = evaluateRangeOrExactPick(pickRaw, H);
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ${homeTeam} ${H} ጎል አስቆጥሯል (ውጤት ${scoreStr})። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '17' || mLower.includes('away total goals') || mLower.includes('total - away')) {
        const won = evaluateRangeOrExactPick(pickRaw, A);
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ${awayTeam} ${A} ጎል አስቆጥሯል (ውጤት ${scoreStr})። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '19' || mLower.includes('clean sheet - home')) {
        const won = ['yes', 'gg'].includes(pick) ? A === 0 : ['no', 'ng'].includes(pick) ? A > 0 : null;
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ${awayTeam} ${A} ጎል አስቆጥሯል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }
    if (mId === '20' || mLower.includes('clean sheet - away')) {
        const won = ['yes', 'gg'].includes(pick) ? H === 0 : ['no', 'ng'].includes(pick) ? H > 0 : null;
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ${homeTeam} ${H} ጎል አስቆጥሯል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '27' || mLower.includes('win to nil - home')) {
        const won = ['yes', 'gg'].includes(pick) ? (H > 0 && A === 0) : ['no', 'ng'].includes(pick) ? !(H > 0 && A === 0) : null;
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ውጤት ${scoreStr} ነው። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }
    if (mId === '28' || mLower.includes('win to nil - away')) {
        const won = ['yes', 'gg'].includes(pick) ? (A > 0 && H === 0) : ['no', 'ng'].includes(pick) ? !(A > 0 && H === 0) : null;
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ውጤት ${scoreStr} ነው። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '2' || mLower.includes('draw no bet')) {
        if (H === A) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: 'postponed',
                explanationAmharic: `[Draw No Bet] ጨዋታው ${scoreStr} አቻ ስለተጠናቀቀ በህጉ መሰረት ኦዱ በ 1.00 (Void) ይሰላል።`
            };
        }
        const won = eval1X2Pick(pickRaw, H, A, homeTeam, awayTeam);
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[Draw No Bet] ጨዋታው ${scoreStr} ተጠናቋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '10' || mId === '31' || mLower.includes('correct score')) {
        const m = pick.match(/(\d+)\s*[:\-]\s*(\d+)/);
        if (m) {
            const pH = parseInt(m[1], 10);
            const pA = parseInt(m[2], 10);
            const won = H === pH && A === pA;
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[Correct Score] ጨዋታው ${scoreStr} ተጠናቋል። የተመረጠው ትክክለኛ ውጤት ${pH}:${pA} ስለሆነ ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '38' || mId === '349' || mLower.includes('exact goals') || mLower.includes('goal range')) {
        const won = evaluateRangeOrExactPick(pickRaw, total);
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ጨዋታው ${scoreStr} (ጠቅላላ ${total} ጎል) ተጠናቋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '62' || mLower.includes('which team to score')) {
        let won = null;
        if (pick.includes('both')) won = H > 0 && A > 0;
        else if (pick.includes('only home') || pick.includes('home only') || pick === '1' || pick === 'w1' || pick === 'home' || teamsMatch(pick, homeTeam)) won = H > 0 && A === 0;
        else if (pick.includes('only away') || pick.includes('away only') || pick === '2' || pick === 'w2' || pick === 'away' || teamsMatch(pick, awayTeam)) won = A > 0 && H === 0;
        else if (pick.includes('none') || pick.includes('neither') || pick.includes('no goal') || pick === 'x') won = H === 0 && A === 0;

        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ጨዋታው ${scoreStr} ተጠናቋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '14' || mId === '15' || mLower.includes('first goal') || mLower.includes('last goal')) {
        const isFirst = mId === '14' || mLower.includes('first goal');
        if (H === 0 && A === 0) {
            const won = pick.includes('none') || pick.includes('no goal') || pick === 'x' || pick === 'draw';
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ጨዋታው 0:0 ስለተጠናቀቀ ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }

        let targetSide = isFirst ? matchData.firstGoalTeam : matchData.lastGoalTeam;
        if (!targetSide) {
            if (H > 0 && A === 0) targetSide = 'home';
            else if (A > 0 && H === 0) targetSide = 'away';
        }

        if (targetSide) {
            let won = null;
            if (pick.includes('none') || pick.includes('no goal')) won = false;
            else if (targetSide === 'home') won = eval1X2Pick(pickRaw, 1, 0, homeTeam, awayTeam);
            else if (targetSide === 'away') won = eval1X2Pick(pickRaw, 0, 1, homeTeam, awayTeam);

            if (won !== null) {
                return {
                    item_id: item.id,
                    match_info: item.match_info,
                    liveScore: scoreStr,
                    aiStatus: won ? 'won' : 'lost',
                    explanationAmharic: `[${canonicalMarket}] ${isFirst ? 'የመጀመሪያውን' : 'የመጨረሻውን'} ጎል ያስቆጠረው ${targetSide === 'home' ? homeTeam : awayTeam} ነው። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
                };
            }
        }
    }

    if (['92', '93', '94'].includes(mId) || mLower.includes('goalscorer')) {
        if (H === 0 && A === 0) {
            const won = pick.includes('no goalscorer') || pick.includes('none') || pick.includes('no goal');
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ጨዋታው 0:0 ስለተጠናቀቀ ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
        if (Array.isArray(matchData.scorers) && matchData.scorers.length > 0) {
            let won = false;
            if (mId === '93' || mLower.includes('first goalscorer')) {
                const firstScorer = matchData.scorers[0] || '';
                won = firstScorer.includes(pick) || pick.includes(firstScorer);
            } else if (mId === '94' || mLower.includes('last goalscorer')) {
                const lastScorer = matchData.scorers[matchData.scorers.length - 1] || '';
                won = lastScorer.includes(pick) || pick.includes(lastScorer);
            } else {
                won = matchData.scorers.some(s => s.includes(pick) || pick.includes(s));
            }
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[${canonicalMarket}] ተጫዋቹ (${pickRaw}) ${won ? 'ጎል አስቆጥሯል (አሸንፏል)' : 'አላስቆጠረም (ተሸንፏል)'}።`
            };
        }
    }

    // 7. መደበኛ የ90 ደቂቃ ጎል ማርኬቶች
    if (mId === '5' || mId === '50' || mLower.includes('total goals') || mLower === 'totals') {
        const won = evalOUPick(pickRaw, total);
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[Total Goals] ጨዋታው ${scoreStr} (ጠቅላላ ${total} ጎል) ተጠናቋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '1' || mLower.includes('match result') || mLower.includes('h2h')) {
        const won = eval1X2Pick(pickRaw, H, A, homeTeam, awayTeam);
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[Match Result] ጨዋታው ${scoreStr} ተጠናቋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '12' || mLower.includes('double chance')) {
        const won = evalDCPick(pickRaw, H, A, homeTeam, awayTeam);
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[Double Chance] ጨዋታው ${scoreStr} ተጠናቋል። ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '8' || mLower.includes('both teams to score') || mLower.includes('btts')) {
        const won = evalBTTSPick(pickRaw, H, A);
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[Both Teams To Score] ጨዋታው ${scoreStr} ተጠናቋል። ሁለቱም ቡድኖች ጎል ${H > 0 && A > 0 ? 'አስቆጥረዋል' : 'አላስቆጠሩም'}፤ ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    if (mId === '21' || mLower.includes('odd/even')) {
        let won = null;
        if (pick.includes('odd')) won = total % 2 === 1;
        else if (pick.includes('even')) won = total % 2 === 0;
        if (won !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: won ? 'won' : 'lost',
                explanationAmharic: `[Odd/Even] ጠቅላላ ${total} ጎል ተቆጥሯል (${total % 2 === 1 ? 'ጎዶሎ/Odd' : 'ሙሉ/Even'})፤ ምርጫዎ (${pickRaw}) ${won ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    const comboFallback = evaluateComboSelection(mId, mLower, pickRaw, H, A, homeTeam, awayTeam);
    if (comboFallback !== null) {
        return {
            item_id: item.id,
            match_info: item.match_info,
            liveScore: scoreStr,
            aiStatus: comboFallback ? 'won' : 'lost',
            explanationAmharic: `[${canonicalMarket}] ጨዋታው ${scoreStr} (ጠቅላላ ${total} ጎል) ተጠናቋል። ጥምር ምርጫዎ (${pickRaw}) ${comboWonText(comboFallback)}።`
        };
    }

    if (mLower === 'match market') {
        const w1x2 = eval1X2Pick(pickRaw, H, A, homeTeam, awayTeam);
        if (w1x2 !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: w1x2 ? 'won' : 'lost',
                explanationAmharic: `[Match Result] ጨዋታው ${scoreStr} ተጠናቋል። ምርጫዎ (${pickRaw}) ${w1x2 ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
        const wdc = evalDCPick(pickRaw, H, A, homeTeam, awayTeam);
        if (wdc !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: wdc ? 'won' : 'lost',
                explanationAmharic: `[Double Chance] ጨዋታው ${scoreStr} ተጠናቋል። ምርጫዎ (${pickRaw}) ${wdc ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
        const wbtts = evalBTTSPick(pickRaw, H, A);
        if (wbtts !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: wbtts ? 'won' : 'lost',
                explanationAmharic: `[Both Teams To Score] ጨዋታው ${scoreStr} ተጠናቋል። ምርጫዎ (${pickRaw}) ${wbtts ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
        const wou = evalOUPick(pickRaw, total);
        if (wou !== null) {
            return {
                item_id: item.id,
                match_info: item.match_info,
                liveScore: scoreStr,
                aiStatus: wou ? 'won' : 'lost',
                explanationAmharic: `[Total Goals] ጨዋታው ${scoreStr} (ጠቅላላ ${total} ጎል) ተጠናቋል። ምርጫዎ (${pickRaw}) ${wou ? 'አሸንፏል' : 'ተሸንፏል'}።`
            };
        }
    }

    const fallbackStatus = item.match_status === 'won' || item.match_status === 'lost' ? item.match_status : 'pending';
    return {
        item_id: item.id,
        match_info: item.match_info,
        liveScore: scoreStr,
        aiStatus: fallbackStatus,
        explanationAmharic: `[${canonicalMarket} - ${pickRaw}] የጨዋታው የ90 ደቂቃ ውጤት ${scoreStr} ነው።`
    };
};

const comboWonText = (won) => (won ? 'ሁለቱንም ቅድመ-ሁኔታዎች ስላሟላ አሸንፏል' : 'አላሸነፈም');

// ⚡ የፍጥነት ማሻሻያ፡ የትኬቱን ጨዋታዎች በተናጠል ከመጠበቅ ይልቅ በ Promise.all በትይዩ (Parallel) እንዲፈተሹ ተደርጓል
const evaluateTicketAccurate = async (ticket, items, scoreMap) => {
    const legs = await Promise.all(
        items.map(async (item) => {
            const matchData = await findMatchStatsForItem(item, ticket, scoreMap);
            return evaluateSingleLegAmharic(item, matchData);
        })
    );

    const wonCount = legs.filter(l => l.aiStatus === 'won').length;
    const lostCount = legs.filter(l => l.aiStatus === 'lost').length;
    const pendingCount = legs.filter(l => l.aiStatus === 'pending').length;

    let summaryAmharic = '';
    if (lostCount > 0) {
        summaryAmharic = `ከ ${legs.length} ጨዋታዎች ውስጥ ${lostCount} ጨዋታ ስለተሸነፈ ትኬቱ አላሸነፈም (LOST)።`;
    } else if (pendingCount > 0) {
        summaryAmharic = `ከ ${legs.length} ጨዋታዎች ${wonCount} አሸንፈዋል፣ ${pendingCount} ጨዋታዎች ደግሞ ገና አልተጠናቀቁም ወይም ዝርዝር ዳታ ይጠብቃሉ (PENDING)።`;
    } else {
        summaryAmharic = `እንኳን ደስ አለዎት! ሁሉም ${legs.length} ጨዋታዎች በትክክል ስላሸነፉ ትኬቱ አሸንፏል (WON)!`;
    }

    return { summaryAmharic, legs };
};

const aiVerifyTicket = async (req, res) => {
    try {
        const code = asText(req.body.ticket_number);

        const [tickets] = await db.query(
            'SELECT * FROM tickets WHERE ticket_number = ? OR booking_code = ?',
            [code, code]
        );
        if (tickets.length === 0) {
            return res.status(404).json({ success: false, message: 'ትኬቱ በዳታቤዝ ውስጥ አልተገኘም!' });
        }

        let ticket = tickets[0];
        let items = await getTicketItems(db, ticket.id);

        const scoreMap = await fetchDetailedMatchStats(items, ticket);
        const finalResult = await evaluateTicketAccurate(ticket, items, scoreMap);

        items = await syncVerifiedTicketToDb(ticket, items, finalResult);

        return res.json({
            success: true,
            data: finalResult,
            updatedTicket: { ...ticket, selections: items, aiAnalysis: finalResult }
        });
    } catch (error) {
        console.error('Verify Error:', error.message);
        return res.status(500).json({ success: false, message: 'ውጤት ማረጋገጥ አልተቻለም' });
    }
};

module.exports = {
    placeTicket, getBooking, confirmBooking, checkTicket, loadTicket, payoutTicket, voidTicket,
    getTicketHistory, getHistory: getTicketHistory, history: getTicketHistory,
    getCashierReport, report: getCashierReport, cashierReport: getCashierReport,
    getSummaryReport, getStaffList, getAllTickets,
    aiVerifyTicket
};