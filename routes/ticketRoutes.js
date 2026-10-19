const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware'); 
const ticketController = require('../controllers/ticketController');

// 🌟 ሰርቨሩ ክራሽ እንዳያደርግ የሚከላከል ሴኪዩሪቲ ፈንክሽን
const safeHandler = (name, fn) => {
    if (typeof fn !== 'function') {
        console.error(`\n🚨 ERROR: '${name}' ፈንክሽን አልተገኘም!`);
        return (req, res) => res.status(500).json({ success: false, message: `Server Error: ${name} is missing.` });
    }
    return fn;
};

// ==========================================
// 1. ራውተሮች (Routes)
// ==========================================

// 🌟 ተስተካክሏል: ቶከን ካለው አንብቦ እንዲያሳልፍ 'optionalVerifyToken' ታክሏል 🌟
router.post('/place', safeHandler('optionalVerifyToken', authMiddleware.optionalVerifyToken), safeHandler('placeTicket', ticketController.placeTicket));

router.get('/booking/:code', safeHandler('getBooking', ticketController.getBooking));

router.post('/booking/:code/confirm', safeHandler('verifyToken', authMiddleware.verifyToken), safeHandler('isStaff', authMiddleware.isStaff), safeHandler('confirmBooking', ticketController.confirmBooking));

router.get('/check/:code', safeHandler('checkTicket', ticketController.checkTicket));

router.post('/ai-verify', safeHandler('verifyToken', authMiddleware.verifyToken), safeHandler('isStaff', authMiddleware.isStaff), safeHandler('aiVerifyTicket', ticketController.aiVerifyTicket));

router.get('/load/:code', safeHandler('loadTicket', ticketController.loadTicket));

router.post('/payout', safeHandler('verifyToken', authMiddleware.verifyToken), safeHandler('isStaff', authMiddleware.isStaff), safeHandler('payoutTicket', ticketController.payoutTicket));

router.post('/void', safeHandler('verifyToken', authMiddleware.verifyToken), safeHandler('isStaff', authMiddleware.isStaff), safeHandler('voidTicket', ticketController.voidTicket));

router.get('/history', safeHandler('verifyToken', authMiddleware.verifyToken), safeHandler('getTicketHistory', ticketController.getTicketHistory));

router.get('/cashier/report', safeHandler('verifyToken', authMiddleware.verifyToken), safeHandler('isStaff', authMiddleware.isStaff), safeHandler('getCashierReport', ticketController.getCashierReport));

// ==========================================
// 2. የአድሚን Routes (Admin Routes)
// ==========================================

router.get('/staff-list', safeHandler('verifyToken', authMiddleware.verifyToken), safeHandler('getStaffList', ticketController.getStaffList));

router.get('/reports/summary', safeHandler('verifyToken', authMiddleware.verifyToken), safeHandler('getSummaryReport', ticketController.getSummaryReport));

router.get('/all', safeHandler('verifyToken', authMiddleware.verifyToken), safeHandler('getAllTickets', ticketController.getAllTickets));

module.exports = router;
