const express = require('express');
const router = express.Router();
const fixtureController = require('../controllers/fixtureController');

// የጨዋታ እና የኦድ ዳታ የሚያመጣበት አድራሻ
router.get('/', fixtureController.getFixtures);

module.exports = router;