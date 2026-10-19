const express = require('express');
const router = express.Router();
const matchController = require('../controllers/matchController');
const { verifyToken, isAdmin } = require('../middleware/authMiddleware');

// የሴቲንግ እና የማዘመን ራውቶች (Tickets ኮድ ከዚህ ወጥቷል!)
router.post('/manual-sync', verifyToken, isAdmin, matchController.manualSync);
router.get('/trigger-settlement', verifyToken, isAdmin, matchController.triggerSettlement);
router.post('/update-api-key', verifyToken, isAdmin, matchController.updateApiKey);
router.get('/get-api-key', verifyToken, isAdmin, matchController.getApiKey);
router.get('/list', verifyToken, isAdmin, matchController.getMatchesList);

// 🌟 አዲስ፡ የ API Usage ራውት 🌟
router.get('/api-usage', verifyToken, isAdmin, matchController.getApiUsage);

module.exports = router;