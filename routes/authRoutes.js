const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware'); // (middleware ፎልደርህን ወደ middlewares ከቀየርከው እዚህም ተቀይሯል)

// 🌟 ሰርቨሩ ክራሽ እንዳያደርግ የሚከላከል እና የጠፋውን ፈንክሽን የሚነግረን ሴኪዩሪቲ ፈንክሽን
const safeHandler = (name, fn) => {
    if (typeof fn !== 'function') {
        console.error(`\n🚨 ስህተት (ERROR): '${name}' የሚባለው ፈንክሽን አልተገኘም (Undefined ነው)! እባክዎ Controller ወይም Middleware ፋይሉን ቼክ ያድርጉ።\n`);
        return (req, res) => res.status(500).json({ success: false, message: `Server Error: ${name} is missing.` });
    }
    return fn;
};

// ==========================================
// Routes (መንገዶች)
// ==========================================

// 0. OTP መላኪያ (ለኦንላይን ተጫዋቾች)
router.post('/send-otp', safeHandler('sendOtp', authController.sendOtp));

// 1. ተጠቃሚ መመዝገቢያ
router.post('/register', safeHandler('registerUser', authController.registerUser));

// 2. ሎጊን
router.post('/login', safeHandler('loginUser', authController.loginUser));

// 3. ሰራተኛ (ካሸር/አድሚን) መመዝገቢያ (የአድሚን ፈቃድ ይፈልጋል)
router.post(
    '/register-staff', 
    safeHandler('verifyToken', authMiddleware.verifyToken), 
    safeHandler('isAdmin', authMiddleware.isAdmin), // ይሄ ከሌለህ middleware ፋይልህ ውስጥ ቼክ አድርገው
    safeHandler('registerStaff', authController.registerStaff)
);

// 4. ሪፖርት መክፈቻ ፓስወርድ ማረጋገጫ (Verify Password)
router.post(
    '/verify-password', 
    safeHandler('verifyToken', authMiddleware.verifyToken), 
    safeHandler('verifyPassword', authController.verifyPassword)
);

// 5. ቶከን (Token) ማረጋገጫ 
router.get('/verify', safeHandler('verifyToken', authMiddleware.verifyToken), (req, res) => {
    return res.json({ 
        success: true, 
        user: req.user 
    });
});

module.exports = router;