const db = require('../config/db');

// የደንበኛውን ባላንስ ለማምጣት
const getBalance = async (req, res) => {
    try {
        const [users] = await db.query('SELECT current_balance FROM users WHERE id = ?', [req.user.id]);
        res.json({ success: true, balance: users[0]?.current_balance || 0 });
    } catch (error) {
        res.status(500).json({ success: false, message: 'ባላንስ ማምጣት አልተቻለም' });
    }
};

// ብር ገቢ ለማድረግ (Deposit Request)
const requestDeposit = async (req, res) => {
    try {
        const { amount, reference_id } = req.body;
        if (!amount || amount < 50) return res.status(400).json({ success: false, message: 'ቢያንስ 50 ብር ማስገባት ያስፈልጋል' });
        
        await db.query(
            `INSERT INTO transactions (user_id, amount, transaction_type, reference_id, status) VALUES (?, ?, 'deposit', ?, 'pending')`,
            [req.user.id, amount, reference_id || '']
        );
        res.json({ success: true, message: 'የዲፖዚት ጥያቄዎ በተሳካ ሁኔታ ተልኳል። በአጭር ጊዜ ውስጥ አድሚን ሲያረጋግጥልዎት ወደ ባላንስዎ ይገባል!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'ጥያቄውን መላክ አልተቻለም' });
    }
};

// ብር ወጪ ለማድረግ (Withdrawal Request)
const requestWithdrawal = async (req, res) => {
    let connection;
    try {
        const { amount, reference_id } = req.body; // reference_id = የደንበኛው ቴሌብር/ባንክ አካውንት ቁጥር ሊሆን ይችላል
        if (!amount || amount < 100) return res.status(400).json({ success: false, message: 'ቢያንስ 100 ብር ማውጣት ያስፈልጋል' });

        connection = await db.getConnection();
        await connection.beginTransaction();

        // ባላንሱን ቼክ ማድረግ
        const [users] = await connection.query('SELECT current_balance FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
        if (users[0].current_balance < amount) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ለዚህ ጥያቄ በቂ ባላንስ የሎትም!' });
        }

        // ገና ጥያቄው ሲላክ ብሩን ከባላንስ ላይ እንቀንሰዋለን (እንዳይደገም/Double-spend እንዳያደርግ)
        await connection.query('UPDATE users SET current_balance = current_balance - ? WHERE id = ?', [amount, req.user.id]);
        
        await connection.query(
            `INSERT INTO transactions (user_id, amount, transaction_type, reference_id, status) VALUES (?, ?, 'withdrawal', ?, 'pending')`,
            [req.user.id, amount, reference_id || '']
        );

        await connection.commit();
        res.json({ success: true, message: 'የወጪ ጥያቄዎ ተቀባይነት አግኝቷል። በቅርብ ጊዜ ወደ አካውንትዎ ይላካል!' });
    } catch (error) {
        if (connection) await connection.rollback();
        res.status(500).json({ success: false, message: 'ጥያቄውን መላክ አልተቻለም' });
    } finally {
        if (connection) connection.release();
    }
};

// የደንበኛውን የትራንዛክሽን ታሪክ ለማየት
const getTransactionHistory = async (req, res) => {
    try {
        const [transactions] = await db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
        res.json({ success: true, data: transactions });
    } catch (error) {
        res.status(500).json({ success: false, message: 'ሂስቶሪ ማምጣት አልተቻለም' });
    }
};

// ==========================================
// 🌟 የአድሚን ክፍሎች (Admin Controls) 🌟
// ==========================================

// አድሚን ሁሉንም ጥያቄዎች እንዲያይ
const adminGetAllTransactions = async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'ያልተፈቀደ' });
    try {
        const [transactions] = await db.query(`
            SELECT t.*, u.username 
            FROM transactions t 
            JOIN users u ON t.user_id = u.id 
            ORDER BY t.created_at DESC LIMIT 200
        `);
        res.json({ success: true, data: transactions });
    } catch (error) {
        res.status(500).json({ success: false });
    }
};

// አድሚን አፕሩቭ (Approve) ወይም ሪጀክት (Reject) ሲያደርግ
const adminProcessTransaction = async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false });
    let connection;
    try {
        const { transaction_id, action } = req.body; // action: 'approved' or 'rejected'
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [txs] = await connection.query('SELECT * FROM transactions WHERE id = ? FOR UPDATE', [transaction_id]);
        if (txs.length === 0 || txs[0].status !== 'pending') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ትራንዛክሽኑ አልተገኘም ወይም አስቀድሞ ተስተናግዷል' });
        }

        const tx = txs[0];

        if (action === 'approved') {
            await connection.query('UPDATE transactions SET status = "approved" WHERE id = ?', [tx.id]);
            // ዲፖዚት ከሆነ ለደንበኛው ባላንስ ላይ ብሩን እንደምረዋለን
            if (tx.transaction_type === 'deposit') {
                await connection.query('UPDATE users SET current_balance = current_balance + ? WHERE id = ?', [tx.amount, tx.user_id]);
            }
            // ዊዝድሮዋል ከሆነ ባላንሱ ላይ ገና ጥያቄው ሲላክ ቀንሰነዋል፣ ስለዚህ ምንም አንጨምርም
            
        } else if (action === 'rejected') {
            await connection.query('UPDATE transactions SET status = "rejected" WHERE id = ?', [tx.id]);
            // ዊዝድሮዋል ሆኖ ከተከለከለ (Reject)፣ የተቀነሰበትን ብር እንመልስለታለን (Refund)
            if (tx.transaction_type === 'withdrawal') {
                await connection.query('UPDATE users SET current_balance = current_balance + ? WHERE id = ?', [tx.amount, tx.user_id]);
            }
        }

        await connection.commit();
        res.json({ success: true, message: 'በትክክል ተስተካክሏል' });
    } catch (error) {
        if (connection) await connection.rollback();
        res.status(500).json({ success: false });
    } finally {
        if (connection) connection.release();
    }
};

module.exports = {
    getBalance, requestDeposit, requestWithdrawal, getTransactionHistory,
    adminGetAllTransactions, adminProcessTransaction
};