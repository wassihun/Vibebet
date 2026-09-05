const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// የ ደህንነት (Auth) ማገናኛዎች
router.post('/register', authController.registerUser);
router.post('/login', authController.loginUser);
router.post('/register-staff', authController.registerStaff);

module.exports = router;