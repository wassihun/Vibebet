const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

// =========================================================================
// 🌟 0. አዲስ: የማረጋገጫ ኮድ (OTP) መላኪያ ለኦንላይን ተጫዋቾች
// =========================================================================
const sendOtp = async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone || phone.length < 9) {
            return res.status(400).json({ success: false, message: 'እባክዎ ትክክለኛ ስልክ ቁጥር ያስገቡ!' });
        }

        const [existingUser] = await db.execute('SELECT id FROM users WHERE phone_number = ?', [phone]);
        if (existingUser.length > 0) {
            return res.status(400).json({ success: false, message: 'ይህ ስልክ ቁጥር አስቀድሞ ተመዝግቧል! እባክዎ ሎጊን ያድርጉ።' });
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60000); // ለ 10 ደቂቃ የሚሰራ

        await db.execute(
            'INSERT INTO otp_records (phone_number, otp_code, expires_at) VALUES (?, ?, ?)',
            [phone, otpCode, expiresAt]
        );

        // 🚨 ለጊዜው SMS API ስላልገዛህ ኮዱን ተርሚናልህ ላይ እንዲያሳየህ አድርጌዋለሁ
        console.log(`\n=========================================`);
        console.log(`📲 SMS SENT TO ${phone}: Your VibeBet code is ${otpCode}`);
        console.log(`=========================================\n`);

        res.json({ success: true, message: 'የማረጋገጫ ኮድ ወደ ስልክዎ ተልኳል!' });
    } catch (error) {
        console.error("OTP Error:", error);
        res.status(500).json({ success: false, message: 'ኮድ መላክ አልተቻለም' });
    }
};

// =========================================================================
// 🌟 1. የተጠቃሚ ምዝገባ (የድሮውንም ሆነ አዲሱን የ OTP ፎርም ያስተናግዳል)
// =========================================================================
const registerUser = async (req, res) => {
    const { username, email, phone_number, password, phone, otp } = req.body;

    try {
        // 🌟 አዲሱ የ OTP ምዝገባ (Online User) 🌟
        if (otp && phone) {
            const [records] = await db.execute(
                'SELECT id FROM otp_records WHERE phone_number = ? AND otp_code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
                [phone, otp]
            );

            if (records.length === 0) {
                return res.status(400).json({ success: false, message: 'የተሳሳተ ወይም ጊዜው ያለፈበት ኮድ ነው!' });
            }

            const saltRounds = 10;
            const password_hash = await bcrypt.hash(password, saltRounds);
            const generatedUsername = username && username.trim() !== '' 
                ? username.trim() 
                : `User_${String(phone).slice(-4)}`;

            const [result] = await db.execute(
                'INSERT INTO users (username, phone_number, password_hash, role, current_balance, status) VALUES (?, ?, ?, ?, ?, ?)',
                [generatedUsername, phone, password_hash, 'user', 0.00, 'active']
            );

            const token = jwt.sign(
                { id: result.insertId, username: generatedUsername, role: 'user', phone: phone },
                process.env.JWT_SECRET,
                { expiresIn: '30d' }
            );

            await db.execute('DELETE FROM otp_records WHERE phone_number = ?', [phone]);

            return res.status(201).json({ 
                success: true, 
                message: 'በተሳካ ሁኔታ ተመዝግበዋል!', 
                token, 
                user: { id: result.insertId, username: generatedUsername, role: 'user', balance: "0.00" } 
            });
        }

        if (phone_number || phone) {
            return res.status(400).json({ success: false, message: 'በአዲሱ ምዝገባ ዘዴ ከ OTP ጋር ብቻ ማስመዝገብ ይቻላል።' });
        }

        // 🌟 የድሮው መመዝገቢያ (ካሼር ወይም ሲስተም ሲመዘግብ - Without OTP) 🌟
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
            return res.status(400).json({ success: false, message: 'ይህ የተጠቃሚ ስም፣ ኢሜል ወይም ስልክ ቁጥር ቀድሞ ተይዟል' });
        }
        console.error("Register Error:", error);
        res.status(500).json({ success: false, message: 'የሰርቨር ስህተት አጋጥሟል' });
    }
};

// =========================================================================
// 🌟 2. የተጠቃሚ እና የሰራተኛ ሎጊን (በስልክ ወይም በ Username ይሰራል)
// =========================================================================
const loginUser = async (req, res) => {
    // ኦንላይን ዩዘሮች 'phone' ይልካሉ፣ ካሼሮች 'username' ይልካሉ
    const { username, phone, password } = req.body;
    const identifier = (phone || username || '').trim();

    if (!identifier || !password) {
        return res.status(400).json({ success: false, message: 'እባክዎ መለያ እና የይለፍ ቃል ያስገቡ!' });
    }

    try {
        const [users] = await db.execute('SELECT * FROM users WHERE username = ? OR phone_number = ?', [identifier, identifier]);

        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'የተጠቃሚ ስም/ስልክ ወይም የይለፍ ቃል ትክክል አይደለም' });
        }

        const user = users[0];

        if (user.status === 'suspended' || user.status === 'blocked') {
            return res.status(403).json({ success: false, message: 'ይህ አካውንት ታግዷል! እባክዎ አድሚን ያነጋግሩ።' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'የተጠቃሚ ስም/ስልክ ወይም የይለፍ ቃል ትክክል አይደለም' });
        }

        const userRole = String(user.role || 'user').toLowerCase().trim();
        const staffRoles = ['cashier', 'admin', 'agent', 'shop', 'superadmin'];

        // 🔒 SECURITY FIX 1: በተጫዋች መግቢያ (phone በሚልከው ፎርም) ካሸር ወይም አድሚን እንዳይገባ መከልከል
        if (phone && !username && staffRoles.includes(userRole)) {
            return res.status(403).json({
                success: false,
                message: 'ይህ የካሸር/የአድሚን አካውንት ነው! በተጫዋች መግቢያ መግባት አይፈቀድም።'
            });
        }

        // 🔒 SECURITY FIX 2: በካሸር/አድሚን መግቢያ (username በሚልከው ፎርም) ተራ ተጫዋች እንዳይገባ መከልከል
        if (username && !phone && !staffRoles.includes(userRole)) {
            return res.status(403).json({
                success: false,
                message: 'ይህ የተጫዋች አካውንት ነው! በሰራተኞች መግቢያ መግባት አይፈቀድም።'
            });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, phone: user.phone_number },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
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
        console.error("Login Error:", error);
        res.status(500).json({ success: false, message: 'የሰርቨር ስህተት አጋጥሟል' });
    }
};

// =========================================================================
// 🌟 3. አዲስ ሰራተኛ (ካሼር/አድሚን) መመዝገቢያ (እንዳለ ነው)
// =========================================================================
const registerStaff = async (req, res) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'ሰራተኛ መመዝገብ የሚችለው አድሚን ብቻ ነው!' });
    }

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
// 🌟 4. የሪፖርት ፓስወርድ ማረጋገጫ (Fail-safe Fix - እንዳለ ነው)
// =========================================================================
const verifyPassword = async (req, res) => {
    const { password } = req.body;

    try {
        let userId = null;

        if (req.user && req.user.id) {
            userId = req.user.id;
        } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
            const token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userId = decoded.id;
        }

        if (!userId) {
            return res.status(401).json({ success: false, message: 'ወደ ሲስተሙ አልገቡም (Unauthorized)' });
        }

        const [users] = await db.execute('SELECT password_hash FROM users WHERE id = ?', [userId]);
        
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'ተጠቃሚው አልተገኘም' });
        }

        const isMatch = await bcrypt.compare(password, users[0].password_hash);
        
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'የተሳሳተ ፓስወርድ ነው!' });
        }

        res.json({ success: true, message: 'ትክክለኛ ፓስወርድ' });

    } catch (error) {
        console.error("Password Verification Error:", error);
        res.status(500).json({ success: false, message: 'የተሳሳተ ፓስወርድ ነው ወይም የሰርቨር ስህተት ተፈጥሯል' });
    }
};

module.exports = {
    sendOtp, // አዲሱ የ OTP መላኪያ
    registerUser,
    loginUser,
    registerStaff,
    verifyPassword
};