const db = require('../config/db');
const crypto = require('crypto'); // 🛡️ የደህንነት ማሻሻያ 2፡ ለመገመት የሚያስቸግሩ ቁጥሮች ለማውጣት

// 🌟 1. ትኬት መቁረጥ እና ማስተዳደር
const placeTicket = async (req, res) => {
    let connection;
    try {
        const { stake_amount, is_guest, selections } = req.body;
        
        // 🔒 SECURITY 1: Strict Input Validation
        const stake = parseFloat(stake_amount);
        if (isNaN(stake) || stake < 20 || stake > 10000) {
            return res.status(400).json({ success: false, message: 'የተሳሳተ የገንዘብ መጠን (Stake)!' });
        }

        if (!Array.isArray(selections) || selections.length === 0) {
            return res.status(400).json({ success: false, message: 'ምንም አይነት ጨዋታ አልተመረጠም!' });
        }

        // 🛡️ የደህንነት ማሻሻያ 1፡ ከአንድ ጨዋታ ከአንድ በላይ ምርጫ መቁረጥን መከልከል (Same-Match Exploit Prevention)
        const uniqueFixtures = new Set(selections.map(s => s.fixture_id));
        if (uniqueFixtures.size !== selections.length) {
            return res.status(400).json({ success: false, message: 'ከአንድ ጨዋታ ከአንድ በላይ ምርጫ ማካተት አይቻልም!' });
        }

        connection = await db.getConnection();

        const fixtureIds = selections.map(s => s.fixture_id);
        const [matches] = await connection.query('SELECT id, commence_time, odds_data FROM saved_matches WHERE id IN (?)', [fixtureIds]);

        let calculatedTotalOdds = 1;
        for (let item of selections) {
            const matchInfo = matches.find(m => m.id == item.fixture_id);
            
            if (!matchInfo) {
                return res.status(400).json({ success: false, message: 'አንዳንድ ጨዋታዎች በሲስተሙ ውስጥ አልተገኙም!' });
            }

            // 🛡️ የደህንነት ማሻሻያ 4፡ ጨዋታው ሊጀምር 1 ደቂቃ (60,000 ms) ሲቀረው መቁረጥ ይዘጋል
            if (new Date(matchInfo.commence_time).getTime() - 60000 < new Date().getTime()) {
                return res.status(400).json({ success: false, message: 'ጨዋታው ሊጀምር ስለሆነ ወይም ስላለፈ መቁረጥ አይቻልም!' });
            }

            const itemOdd = parseFloat(item.odd_value);
            if (isNaN(itemOdd) || itemOdd < 1) {
                console.log("❌ Invalid Odd Received:", item);
                return res.status(400).json({ success: false, message: `የተሳሳተ የኦድስ (Odds) ዋጋ ተገኝቷል (${item.odd_value})!` });
            }

            // ⚠️ ODDS SECURITY: ተጫዋቹ የላከው ኦድ ትክክለኛ መሆኑን ማረጋገጥ
            let isOddValid = false;
            try {
                const oddsData = JSON.parse(matchInfo.odds_data);
                for (const bm of oddsData) {
                    for (const m of bm.markets) {
                        for (const o of m.outcomes) {
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

        // 🛡️ የደህንነት ማሻሻያ 5፡ Floating Point Precision Fix
        calculatedTotalOdds = Math.round(calculatedTotalOdds * 100) / 100;
        let calculatedPotentialWin = Math.round((calculatedTotalOdds * stake) * 100) / 100;
        
        const maxWinLimit = 10000;
        if (calculatedPotentialWin > maxWinLimit) {
            return res.status(400).json({ success: false, message: `ከፍተኛው ማሸነፊያ ${maxWinLimit} ብር ብቻ ነው!` });
        }

        let userId = null;
        if (!is_guest && req.user) userId = req.user.id;

        // 🛡️ የደህንነት ማሻሻያ 2፡ Cryptographically Secure Random Numbers
        const ticketNumber = is_guest ? null : crypto.randomInt(10000000, 99999999).toString();
        const bookingCode = is_guest ? crypto.randomInt(100000, 999999).toString() : null;
        const status = is_guest ? 'pending' : 'active';

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
        console.error("❌ Place Ticket DB Error:", error);
        res.status(500).json({ success: false, message: 'ትኬት መቁረጥ አልተቻለም', db_error: error.message });
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

        const [items] = await connection.query('SELECT fixture_id FROM ticket_items WHERE ticket_id = ?', [ticket.id]);
        const fixtureIds = items.map(i => i.fixture_id);
        
        if (fixtureIds.length > 0) {
            const [matches] = await connection.query('SELECT id, commence_time FROM saved_matches WHERE id IN (?)', [fixtureIds]);
            for (let match of matches) {
                // 🛡️ የደህንነት ማሻሻያ 4 (በ Confirm ጊዜም)፡ 1 ደቂቃ Buffer
                if (new Date(match.commence_time).getTime() - 60000 < new Date().getTime()) {
                    await connection.rollback();
                    return res.status(400).json({ success: false, message: 'በትኬቱ ውስጥ የጀመሩ ጨዋታዎች ስላሉ ማረጋገጥ አይቻልም! እባክዎ አዲስ ይቁረጡ።' });
                }
            }
        }
        
        // 🛡️ የደህንነት ማሻሻያ 2
        const ticketNumber = crypto.randomInt(10000000, 99999999).toString();
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

// 🌟 የፍሮንትኤንድ ማረጋገጫ
const checkTicket = async (req, res) => {
    try {
        const code = req.params.code.trim(); 
        const [tickets] = await db.query('SELECT * FROM tickets WHERE ticket_number = ? OR booking_code = ?', [code, code]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ይህ ትኬት አልተገኘም! ቁጥሩን በትክክል ያስገቡ።' });

        let ticket = tickets[0];
        const [items] = await db.query('SELECT ti.*, sm.commence_time FROM ticket_items ti LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id WHERE ti.ticket_id = ?', [ticket.id]);
        
        if (ticket.status === 'active' || ticket.status === 'pending') {
            let isLost = false;
            let isPending = false;
            let calculatedOdds = 1;

            items.forEach(item => {
                if (item.match_status === 'lost') {
                    isLost = true;
                } else if (item.match_status === 'won') {
                    calculatedOdds *= parseFloat(item.odd_value);
                } else if (item.match_status === 'postponed' || item.match_status === 'cancelled' || item.match_status === 'abandoned') {
                    calculatedOdds *= 1; 
                } else {
                    isPending = true; 
                }
            });

            if (isLost) {
                ticket.status = 'lost';
            } else if (isPending) {
                ticket.status = 'pending';
            } else {
                ticket.status = 'won';
                ticket.potential_win = (calculatedOdds * parseFloat(ticket.stake_amount)).toFixed(2);
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

// 🌟 2. ክፍያ (Payout) 100% አስተማማኝ
const payoutTicket = async (req, res) => {
    try {
        const ticketNumber = req.body.ticket_number ? String(req.body.ticket_number).trim() : '';
        if (!ticketNumber) {
            return res.status(400).json({ success: false, message: 'የትኬት ቁጥር አልተላከም' });
        }

        const [tickets] = await db.query('SELECT * FROM tickets WHERE ticket_number = ? OR booking_code = ?', [ticketNumber, ticketNumber]);
        
        if (tickets.length === 0) {
            return res.status(404).json({ success: false, message: 'ትኬቱ አልተገኘም' });
        }

        const ticket = tickets[0];
        
        if (ticket.status === 'paid') return res.status(400).json({ success: false, message: 'ይህ ትኬት አስቀድሞ ተከፍሎታል!' });
        if (ticket.status === 'void') return res.status(400).json({ success: false, message: 'ይህ ትኬት የተሰረዘ (Void) ነው!' });

        const [items] = await db.query('SELECT ti.*, sm.commence_time FROM ticket_items ti LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id WHERE ti.ticket_id = ?', [ticket.id]);

        let lastMatchTime = new Date(ticket.created_at).getTime();
        let isLost = false;
        let isPending = false;
        let calculatedOdds = 1;

        items.forEach(item => {
            const mTime = new Date(item.commence_time || ticket.created_at).getTime();
            if (mTime > lastMatchTime) lastMatchTime = mTime;

            if (item.match_status === 'lost') {
                isLost = true;
            } else if (item.match_status === 'won') {
                calculatedOdds *= parseFloat(item.odd_value);
            } else if (item.match_status === 'postponed' || item.match_status === 'cancelled' || item.match_status === 'abandoned') {
                calculatedOdds *= 1; 
            } else {
                isPending = true; 
            }
        });

        if (Date.now() > lastMatchTime + (3 * 24 * 60 * 60 * 1000)) {
            await db.query("UPDATE tickets SET status = 'expired' WHERE id = ?", [ticket.id]);
            return res.status(400).json({ success: false, message: 'የዚህ ትኬት መክፈያ ጊዜ (3 ቀን) አልፏል! ክፍያው ውድቅ ሆኗል።' });
        }

        if (isLost || ticket.status === 'lost') {
            return res.status(400).json({ success: false, message: 'ይህ ትኬት አላሸነፈም (ተሸንፏል)!' });
        }

        if (isPending) {
            return res.status(400).json({ success: false, message: 'ትኬቱ አሁንም ውጤት እየጠበቀ (Pending) ነው! ሁሉም ጨዋታዎች አላለቁም።' });
        }

        const finalWinAmount = (calculatedOdds * parseFloat(ticket.stake_amount)).toFixed(2);

        const [updateResult] = await db.query(
            "UPDATE tickets SET status = 'paid', potential_win = ? WHERE id = ? AND status != 'paid'", 
            [finalWinAmount, ticket.id]
        );

        if (updateResult.affectedRows === 0) {
            return res.status(400).json({ success: false, message: 'ክፍያው አስቀድሞ ተፈጽሟል!' });
        }
        
        res.json({ success: true, message: 'ክፍያው በተሳካ ሁኔታ ተፈጽሟል', payout_data: { amount_paid: finalWinAmount } });

    } catch (error) { 
        console.error("Payout Error: ", error);
        res.status(500).json({ success: false, message: 'ክፍያ መፈጸም አልተቻለም (Server Error)' }); 
    }
};

const voidTicket = async (req, res) => {
    try {
        const [tickets] = await db.query('SELECT id, user_id, status, created_at FROM tickets WHERE ticket_number = ?', [req.body.ticket_number.trim()]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'ትኬቱ አልተገኘም' });

        const ticket = tickets[0];
        if (ticket.status !== 'active') return res.status(400).json({ success: false, message: 'ትኬቱ አክቲቭ አይደለም (መሰረዝ አይቻልም)' });
        if (ticket.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'መሰረዝ የሚችለው የቆረጠው ካሼር ብቻ ነው' });

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
        // 🛡️ የደህንነት ማሻሻያ 3፡ ሰርቨርን ላለማጨናነቅ LIMIT 200 (ወይም እንደፍላጎትህ) ተጨምሯል
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

module.exports = {
    placeTicket, getBooking, confirmBooking, checkTicket, loadTicket,
    payoutTicket, voidTicket,
    getHistory, getCashierReport, getSummaryReport, getStaffList, 
    getAllTickets 
};