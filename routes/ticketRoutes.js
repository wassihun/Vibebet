const express = require('express');
const router = express.Router();
// 🌟 ማስተካከያ፡ የፋይሉን ስም ልክ አንተ ሴቭ እንዳደረግከው በስሞል ሌተር አድርጌዋለሁ 🌟
const { verifyToken } = require('../middleware/authMiddleware');
const ticketController = require('../controllers/ticketController');

// 1. ትኬት መቁረጥ፣ ቡኪንግ እና ቼክ ማድረግ (አንዳንዶቹ ቶከን አይፈልጉም)
router.post('/place', ticketController.placeTicket);
router.get('/booking/:code', ticketController.getBooking);
router.post('/booking/:code/confirm', verifyToken, ticketController.confirmBooking);
router.get('/check/:code', ticketController.checkTicket);
router.get('/load/:code', ticketController.loadTicket);

// 2. የካሼር ክፍያ (Payout) እና ስረዛ (Void)
router.post('/payout', verifyToken, ticketController.payoutTicket);
router.post('/void', verifyToken, ticketController.voidTicket);

// 3. የካሼር እና አድሚን ሪፖርቶች
router.get('/history', verifyToken, ticketController.getHistory);
router.get('/cashier/report', verifyToken, ticketController.getCashierReport);
router.get('/reports/summary', verifyToken, ticketController.getSummaryReport);
router.get('/staff-list', verifyToken, ticketController.getStaffList);

module.exports = router;