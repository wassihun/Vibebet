const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// 🌟 አዲስ የተጨመሩ ሚድልዌሮች (ለሴኪዩሪቲ) 🌟
const { verifyToken, isAdmin } = require('../middleware/authMiddleware');

// የ ደህንነት (Auth) ማገናኛዎች
router.post('/register', authController.registerUser);
router.post('/login', authController.loginUser);

// 🌟 SECURITY: ጥብቁ የአድሚን መመዝገቢያ (verifyToken እና isAdmin አብረው መኖር አለባቸው)
router.post('/register-staff', verifyToken, isAdmin, authController.registerStaff);

// =========================================================================
// 🌟 የሪፖርት ፓስወርድ ማረጋገጫ API 🌟
// =========================================================================
router.post('/verify-password', verifyToken, authController.verifyPassword);

module.exports = router;