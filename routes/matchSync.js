const express = require('express');
const router = express.Router();
const matchController = require('../controllers/matchController');
const { verifyToken, isAdmin } = require('../middleware/authMiddleware');

// 🟢 ጨዋታዎችን ማየት ለሁሉም ሰው ክፍት መሆን አለበት (verifyToken እና isAdmin ተነስተዋል)
router.get('/list', matchController.getMatchesList);

// የሴቲንግ እና የማዘመን ራውቶች (ለ Admin ብቻ)
router.post('/manual-sync', verifyToken, isAdmin, matchController.manualSync);
router.get('/trigger-settlement', verifyToken, isAdmin, matchController.triggerSettlement);
router.post('/update-api-key', verifyToken, isAdmin, matchController.updateApiKey);
router.get('/get-api-key', verifyToken, isAdmin, matchController.getApiKey);
router.get('/api-usage', verifyToken, isAdmin, matchController.getApiUsage);

module.exports = router;