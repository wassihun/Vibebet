const express = require('express');
const router = express.Router();
const matchController = require('../controllers/matchController');

// የሴቲንግ እና የማዘመን ራውቶች (Tickets ኮድ ከዚህ ወጥቷል!)
router.post('/manual-sync', matchController.manualSync);
router.get('/trigger-settlement', matchController.triggerSettlement);
router.post('/update-api-key', matchController.updateApiKey);
router.get('/get-api-key', matchController.getApiKey);
router.get('/list', matchController.getMatchesList);

// 🌟 አዲስ፡ የ API Usage ራውት 🌟
router.get('/api-usage', matchController.getApiUsage);

module.exports = router;