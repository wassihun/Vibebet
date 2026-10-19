const express = require('express');
const router = express.Router();
const { 
    getBalance, requestDeposit, requestWithdrawal, getTransactionHistory,
    adminGetAllTransactions, adminProcessTransaction 
} = require('../controllers/walletController');
const { verifyToken, isAdmin } = require('../middleware/authMiddleware'); // 🌟 isAdmin ተጨምሯል

// ደንበኞች የሚጠቀሙት (Users Routes)
router.get('/balance', verifyToken, getBalance);
router.post('/deposit', verifyToken, requestDeposit);
router.post('/withdraw', verifyToken, requestWithdrawal);
router.get('/history', verifyToken, getTransactionHistory);

// አድሚን የሚጠቀመው (Admin Routes) - 🌟 isAdmin ተጨምሯል
router.get('/admin/transactions', verifyToken, isAdmin, adminGetAllTransactions);
router.post('/admin/process', verifyToken, isAdmin, adminProcessTransaction);

module.exports = router;