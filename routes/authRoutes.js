const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// 🌟 የካሸሩን ቶከን ቼክ የሚያደርገው ሚድልዌር (Middleware) ኢምፖርት ማድረግ 🌟
// ማስታወሻ: የ middleware ፋይልህ አቀማመጥ ወይም ስም ከተለየ (ምሳሌ: '../middlewares/auth' ወዘተ) ወደ ትክክለኛው ስም ቀይረው
const authenticateToken = require('../middleware/authMiddleware'); 

// የ ደህንነት (Auth) ማገናኛዎች
router.post('/register', authController.registerUser);
router.post('/login', authController.loginUser);
router.post('/register-staff', authController.registerStaff);

// =========================================================================
// 🌟 አዲሱ የሪፖርት ፓስወርድ ማረጋገጫ API 🌟
// =========================================================================
router.post('/verify-password', authenticateToken, authController.verifyPassword);

module.exports = router;
