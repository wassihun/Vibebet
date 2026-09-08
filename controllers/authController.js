const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

// የተጠቃሚ ምዝገባ
const registerUser = async (req, res) => {
    const { username, email, phone_number, password } = req.body;

    try {
        const safeEmail = email || null;
        const safePhone = phone_number || null;

        const saltRounds = 10;
        const password_hash = await bcrypt.hash(password, saltRounds);

        const query = `INSERT INTO users (username, email, phone_number, password_hash) VALUES (?, ?, ?, ?)`;
        const [result] = await db.execute(query, [username, safeEmail, safePhone, password_hash]);

        res.status(201).json({ 
            success: true, 
            message: 'ተጠቃሚው በተሳካ ሁኔታ ተመዝግቧል!', 
            userId: result.insertId 
        });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'ይህ የተጠቃሚ ስም ወይም ኢሜል ቀድሞ ተይዟል' });
        }
        res.status(500).json({ success: false, message: 'የሰርቨር ስህተት አጋጥሟል' });
    }
};

// የተጠቃሚ እና የሰራተኛ ሎጊን
const loginUser = async (req, res) => {
    const { username, password } = req.body;

    try {
        const [users] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);

        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'የተጠቃሚ ስም ወይም የይለፍ ቃል ትክክል አይደለም' });
        }

        const user = users[0];

        if (user.status === 'suspended') {
            return res.status(403).json({ success: false, message: 'ይህ አካውንት ታግዷል' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'የተጠቃሚ ስም ወይም የይለፍ ቃል ትክክል አይደለም' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            process.env.JWT_SECRET || 'super_secret_betting_key_2026',
            { expiresIn: '24h' }
        );

        res.status(200).json({
            success: true,
            message: 'በተሳካ ሁኔታ ሎጊን አድርገዋል',
            token,
            user: { 
                id: user.id, 
                username: user.username, 
                role: user.role, 
                balance: user.current_balance 
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: 'የሰርቨር ስህተት አጋጥሟል' });
    }
};

// አዲስ ሰራተኛ (ካሼር/አድሚን) መመዝገቢያ
const registerStaff = async (req, res) => {
    const { username, password, role } = req.body;

    try {
        const saltRounds = 10;
        const password_hash = await bcrypt.hash(password, saltRounds);

        const query = `INSERT INTO users (username, password_hash, role, current_balance) VALUES (?, ?, ?, 0)`;
        await db.execute(query, [username, password_hash, role]);

        res.json({ success: true, message: `✅ ${role === 'cashier' ? 'ካሼሩ' : 'አድሚኑ'} በተሳካ ሁኔታ ተመዝግቧል!` });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'ይህ ዩዘርኔም አስቀድሞ ተይዟል! እባክዎ ሌላ ይሞክሩ።' });
        }
        res.status(500).json({ success: false, message: 'ሰራተኛውን መመዝገብ አልተቻለም' });
    }
};

// =========================================================================
// 🌟 አዲሱ ኮድ: የካሸር ሪፖርት ለመክፈት ፓስወርድ ማረጋገጫ (Security Fix) 🌟
// =========================================================================
const verifyPassword = async (req, res) => {
    const { password } = req.body;

    try {
        // authenticateToken ሚድልዌር የካሸሩን መረጃ ከ Token ያወጣዋል ብለን እናስባለን
        const userId = req.user.id; 

        // 1. ካሸሩን ከዳታቤዝ ፈልጎ ማምጣት (በዚህ ፋይል ላይ እንዳየሁት ኮለሙ 'password_hash' ይባላል)
        const [users] = await db.execute('SELECT password_hash FROM users WHERE id = ?', [userId]);
        
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'ተጠቃሚው አልተገኘም' });
        }

        // 2. የተላከውን ፓስወርድ ዳታቤዝ ላይ ካለው (Hashed Password) ጋር ማመሳከር
        const isMatch = await bcrypt.compare(password, users[0].password_hash);
        
        if (!isMatch) {
            // ፓስወርዱ ከተሳሳተ
            return res.status(401).json({ success: false, message: 'የተሳሳተ ፓስወርድ ነው!' });
        }

        // 3. ፓስወርዱ ትክክል ከሆነ (Access Granted)
        res.json({ success: true, message: 'ትክክለኛ ፓስወርድ' });

    } catch (error) {
        console.error("Password Verification Error:", error);
        res.status(500).json({ success: false, message: 'የሰርቨር ስህተት ተፈጥሯል' });
    }
};

module.exports = {
    registerUser,
    loginUser,
    registerStaff,
    verifyPassword // 🌟 አዲሱ ፈንክሽን እዚህ ላይ ተጨምሯል 🌟
};
