const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { fetchAndSaveMatches } = require('../services/oddsService');

// =========================================================================
// 🌟 ጨዋታዎችን ከ MySQL (saved_matches) በቀጥታ ማምጣት (የድሮውን The Odds API 401 ስህተት ያስቀራል)
// =========================================================================
const getSavedFixturesHandler = async (req, res) => {
    try {
        // 1. መጀመሪያ ወደፊት የሚደረጉ እና ኦድ ያላቸውን ጨዋታዎች ማምጣት
        let [rows] = await db.query(`
            SELECT * FROM saved_matches
            WHERE odds_data IS NOT NULL
              AND odds_data != '[]'
              AND commence_time > NOW() - INTERVAL 2 HOUR
              AND (match_status IS NULL OR match_status IN ('NS', 'TBD', '1H', 'HT', '2H', 'LIVE'))
            ORDER BY commence_time ASC
        `);

        // 2. ወደፊት የሚደረጉ ጨዋታዎች ገና ካልተመዘገቡ፣ በዳታቤዝ ውስጥ ያሉትን ኦድ ያላቸው ጨዋታዎች ማምጣት
        if (!rows || rows.length === 0) {
            [rows] = await db.query(`
                SELECT * FROM saved_matches
                WHERE odds_data IS NOT NULL
                  AND odds_data != '[]'
                ORDER BY commence_time DESC
                LIMIT 300
            `);
        }

        // 3. ዳታቤዙ ሙሉ በሙሉ ባዶ ከሆነ፣ ከ API-Football አውቶማቲካሊ Sync እንዲያደርግ ማስጀመር
        if ((!rows || rows.length === 0) && typeof fetchAndSaveMatches === 'function') {
            fetchAndSaveMatches().catch((err) => {
                console.error('Background match sync error:', err.message);
            });
        }

        return res.json({
            success: true,
            count: rows ? rows.length : 0,
            data: rows || []
        });
    } catch (error) {
        console.error('Error fetching saved matches:', error.message);
        return res.status(500).json({
            success: false,
            message: 'ጨዋታዎችን ከዳታቤዝ ማምጣት አልተቻለም።',
            data: []
        });
    }
};

// GET /api/fixtures
router.get('/', getSavedFixturesHandler);

// GET /api/fixtures/list
router.get('/list', getSavedFixturesHandler);

module.exports = router;
