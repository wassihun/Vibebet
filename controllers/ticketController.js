const db = require('../config/db');

// 🌟 1. ትኬት መቁረጥ እና ማስተዳደር
const placeTicket = async (req, res) => {
    let connection;
    try {
        const { stake_amount, is_guest, selections } = req.body;
        
        // 🔒 SECURITY 1: Strict Input Validation (ክሊየንቱን አናምንም)
        const stake = parseFloat(stake_amount);
        if (isNaN(stake) || stake < 20 || stake > 10000) {
            return res.status(400).json({ success: false, message: 'የተሳሳተ የገንዘብ መጠን (Stake)!' });
        }

        if (!Array.isArray(selections) || selections.length === 0) {
            return res.status(400).json({ success: false, message: 'ምንም አይነት ጨዋታ አልተመረጠም!' });
        }

        connection = await db.getConnection();

        // 🔒 SECURITY 2: የጨዋታ ጊዜ (Time) እና የኦድ (Odds) ማጭበርበርን ከዳታቤዝ ጋር ማረጋገጥ
        const fixtureIds = selections.map(s => s.fixture_id);
        const [matches] = await connection.query('SELECT id, commence_time, odds_data FROM saved_matches WHERE id IN (?)', [fixtureIds]);

        let calculatedTotalOdds = 1;
        for (let item of selections) {
            const matchInfo = matches.find(m => m.id == item.fixture_id);
            
            if (!matchInfo) {
                return res.status(400).json({ success: false, message: 'አንዳንድ ጨዋታዎች በሲስተሙ ውስጥ አልተገኙም!' });
            }

            // ⚠️ TIME SECURITY: ጨዋታው ከጀመረ መቁረጥን መከልከል
            if (new Date(matchInfo.commence_time).getTime() < new Date().getTime()) {
                return res.status(400).json({ success: false, message: 'የጀመረ ወይም ያለፈ ጨዋታ መቁረጥ አይቻልም!' });
            }

            const itemOdd = parseFloat(item.odd_value);
            if (isNaN(itemOdd) || itemOdd <= 1) {
                return res.status(400).json({ success: false, message: 'የተሳሳተ የኦድስ (Odds) ዋጋ ተገኝቷል!' });
            }

            // ⚠️ ODDS SECURITY: ተጫዋቹ የላከው ኦድ (Price) ትክክለኛ መሆኑን ማረጋገጥ
            let isOddValid = false;
            try {
                const oddsData = JSON.parse(matchInfo.odds_data);
                for (const bm of oddsData) {
                    for (const m of bm.markets) {
                        for (const o of m.outcomes) {
                            // የላከው እና ዳታቤዝ ላይ ያለው ኦድ ልዩነት ከ 0.01 በታች መሆኑን ያረጋግጣል
                            if (Math.abs(parseFloat(o.price) - itemOdd) < 0.01) {
                                isOddValid = true;
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Odds checking error", e);
            }

            if (!isOddValid) {
                return res.status(400).json({ success: false, message: 'የተጭበረበረ ወይም የተቀየረ ኦድ (Odds) ዋጋ ተገኝቷል!' });
            }

            calculatedTotalOdds *= itemOdd;
        }

        const maxWinLimit = 10000;
        let calculatedPotentialWin = calculatedTotalOdds * stake;
        if (calculatedPotentialWin > maxWinLimit) {
            return res.status(400).json({ success: false, message: `ከፍተኛው ማሸነፊያ ${maxWinLimit} ብር ብቻ ነው!` });
        }

        let userId = null;
        if (!is_guest && req.user) userId = req.user.id;

        const ticketNumber = is_guest ? null : Math.floor(10000000 + Math.random() * 90000000).toString();
        const bookingCode = is_guest ? Math.floor(100000 + Math.random() * 900000).toString() : null;
        const status = is_guest ? 'pending' : 'active';

        // 🔒 SECURITY 3: Transactional Data Insert (ግማሽ ዳታ እንዳይገባ ይከላከላል)
        await connection.beginTransaction();

        const [ticketResult] = await connection.query(
            'INSERT INTO tickets (user_id, ticket_number, booking_code, stake_amount, total_odds, potential_win, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, ticketNumber, bookingCode, stake, calculatedTotalOdds.toFixed(2), calculatedPotentialWin.toFixed(2), status]
        );

        for (let item of selections) {
            await connection.query(
                'INSERT INTO ticket_items (ticket_id, fixture_id, odd_id, odd_value, match_info, odd_name) VALUES (?, ?, ?, ?, ?, ?)',
                [ticketResult.insertId, item.fixture_id, item.odd_id, parseFloat(item.odd_value).toFixed(2), item.match_info || 'Match', item.odd_name || 'Odd']
            );
        }

        await connection.commit();
        res.json({ success: true, data: { ticket_number: ticketNumber, booking_code: bookingCode } });
    } catch (error) {
        if (connection) await connection.rollback();
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
        // 🔒 SECURITY: Use Transaction + Row Lock (FOR UPDATE) to prevent duplicate confirming (Idempotency)
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [tickets] = await connection.query('SELECT * FROM tickets WHERE booking_code = ? FOR UPDATE', [req.params.code.trim()]);
        if (tickets.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'ቡኪንግ ኮድ አልተገኘም' });
        }
        
        const ticket = tickets[0];
        if (ticket.status !== 'pending' || ticket.ticket_number) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ይህ ትኬት አስቀድሞ ተቆርጧል ወይም ተሰርዟል!' });
        }

        // ⚠️ TIME SECURITY: ካሼሩ Confirm ሲያደርግ ጨዋታው መጀመሩን ደግሞ ቼክ ማድረግ
        const [items] = await connection.query('SELECT fixture_id FROM ticket_items WHERE ticket_id = ?', [ticket.id]);
        const fixtureIds = items.map(i => i.fixture_id);
        
        if (fixtureIds.length > 0) {
            const [matches] = await connection.query('SELECT id, commence_time FROM saved_matches WHERE id IN (?)', [fixtureIds]);
            for (let match of matches) {
                if (new Date(match.commence_time).getTime() < new Date().getTime()) {
                    await connection.rollback();
                    return res.status(400).json({ success: false, message: 'በትኬቱ ውስጥ የጀመሩ ጨዋታዎች ስላሉ ማረጋገጥ አይቻልም! እባክዎ አዲስ ይቁረጡ።' });
                }
            }
        }
        
        const ticketNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
        await connection.query('UPDATE tickets SET ticket_number = ?, status = ?, user_id = ? WHERE id = ?', [ticketNumber, 'active', req.user.id, ticket.id]);
        
        await connection.commit();
        res.json({ success: true, data: { ticket_number: ticketNumber } });
    } catch (error) { 
        if (connection) await connection.rollback();
        res.status(500).json({ success: false }); 
    } finally {
        if (connection) connection.release();
    }
};

const checkTicket = async (req, res) => {
    try {
        const code = req.params.code.trim(); 
        const [tickets] = await db.query('SELECT * FROM tickets WHERE ticket_number = ? OR booking_code = ?', [code, code]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ይህ ትኬት አልተገኘም! ቁጥሩን በትክክል ያስገቡ።' });

        const [items] = await db.query('SELECT ti.*, sm.commence_time FROM ticket_items ti LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id WHERE ti.ticket_id = ?', [tickets[0].id]);
        res.json({ success: true, data: { ...tickets[0], selections: items } });
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

// 🌟 2. ክፍያ እና ስረዛ (Cashier Actions)
const payoutTicket = async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 🔒 Lock the ticket row to prevent paying out twice concurrently
        const [tickets] = await connection.query('SELECT * FROM tickets WHERE ticket_number = ? FOR UPDATE', [req.body.ticket_number.trim()]);
        
        if (tickets.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'ትኬቱ አልተገኘም' });
        }

        const ticket = tickets[0];
        if (ticket.status === 'paid') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ይህ ትኬት አስቀድሞ ተከፍሎታል!' });
        }
        if (ticket.status === 'expired') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'የዚህ ትኬት መክፈያ ጊዜ አልፏል' });
        }
        if (ticket.status !== 'won') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ይህ ትኬት አላሸነፈም!' });
        }

        await connection.query("UPDATE tickets SET status = 'paid' WHERE id = ?", [ticket.id]);
        
        await connection.commit();
        res.json({ success: true, message: 'ክፍያው በተሳካ ሁኔታ ተፈጽሟል', payout_data: { amount_paid: ticket.potential_win } });

    } catch (error) { 
        if (connection) await connection.rollback();
        res.status(500).json({ success: false, message: 'ክፍያ መፈጸም አልተቻለም' }); 
    } finally {
        if (connection) connection.release();
    }
};

const voidTicket = async (req, res) => {
    try {
        const [tickets] = await db.query('SELECT id, user_id, status, created_at FROM tickets WHERE ticket_number = ?', [req.body.ticket_number.trim()]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ትኬቱ አልተገኘም' });

        const ticket = tickets[0];
        if (ticket.status !== 'active') return res.status(400).json({ success: false, message: 'ትኬቱ አክቲቭ አይደለም (መሰረዝ አይቻልም)' });
        if (ticket.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'መሰረዝ የሚችለው የቆረጠው ካሼር ብቻ ነው' });

        // 🔒 SECURITY: Calculate time difference directly in the Database (Prevents Server/DB Timezone hacks)
        const [timeCheck] = await db.query('SELECT TIMESTAMPDIFF(MINUTE, created_at, NOW()) as diff FROM tickets WHERE id = ?', [ticket.id]);
        if (timeCheck[0].diff >= 5) {
            return res.status(400).json({ success: false, message: 'ትኬቱን መሰረዝ የሚቻለው ከተቆረጠ በ 5 ደቂቃ ውስጥ ብቻ ነው!' });
        }

        await db.query("UPDATE tickets SET status = 'void' WHERE id = ?", [ticket.id]);
        res.json({ success: true, message: 'ትኬቱ በተሳካ ሁኔታ ተሰርዟል (Voided)' });
    } catch (error) { res.status(500).json({ success: false, message: 'ትኬቱን መሰረዝ አልተቻለም' }); }
};

// 🌟 3. ሪፖርቶች (Reports & History)
const getHistory = async (req, res) => {
    try {
        const [tickets] = await db.query("SELECT ticket_number, stake_amount, potential_win, status, created_at FROM tickets WHERE user_id = ? AND status != 'pending' ORDER BY created_at DESC LIMIT 20", [req.user.id]);
        res.json({ success: true, data: tickets });
    } catch (error) { res.status(500).json({ success: false }); }
};

const getCashierReport = async (req, res) => {
    // 🔒 NOTE: To fully secure this, ensure your Router middleware checks for the specific token issued by `verify-password`
    // e.g. using `req.headers['x-report-token']` before calling this controller.

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
        const [winningTickets] = await db.query(`SELECT t.ticket_number, u.username as cashier, u.role, t.stake_amount, t.potential_win, t.status, t.created_at FROM tickets t LEFT JOIN users u ON t.user_id = u.id WHERE (t.status = 'won' OR t.status = 'expired') AND ${dateCondition} ORDER BY t.created_at DESC`);
        
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

module.exports = {
    placeTicket, getBooking, confirmBooking, checkTicket, loadTicket,
    payoutTicket, voidTicket,
    getHistory, getCashierReport, getSummaryReport, getStaffList
};