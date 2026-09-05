const db = require('../config/db');
const oddsService = require('../services/oddsService');

const manualSync = async (req, res) => {
    const success = await oddsService.fetchAndSaveMatches();
    if (success) res.json({ success: true, message: '✅ ዳታው በተሳካ ሁኔታ ከ The Odds API መጥቶ ተዘምኗል!' });
    else res.status(500).json({ success: false, message: 'ማዘመን አልተቻለም (API Key ያረጋግጡ)' });
};

const triggerSettlement = async (req, res) => {
    oddsService.runAutoSettlement();
    res.json({ success: true, message: '✅ የውጤት ማጣራት ትዕዛዝ ተሰጥቷል! ተርሚናልዎን ይመልከቱ።' });
};

const updateApiKey = async (req, res) => {
    try {
        await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'odds_api_key'", [req.body.api_key.trim()]);
        res.json({ success: true, message: '✅ API Key በተሳካ ሁኔታ ተቀይሯል!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'መቀየር አልተቻለም' });
    }
};

const getApiKey = async (req, res) => {
    const api_key = await oddsService.getApiKey();
    res.json({ success: true, api_key });
};

const getMatchesList = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM saved_matches WHERE commence_time > NOW() ORDER BY commence_time ASC');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'ማምጣት አልተቻለም' });
    }
};

// 🌟 አዲስ፡ የ API Usage መረጃን ከዳታቤዝ የሚያመጣው ፋንክሽን 🌟
const getApiUsage = async (req, res) => {
    try {
        const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('api_used', 'api_remaining')");
        let usage = { used: 0, remaining: 0 };
        rows.forEach(row => {
            if (row.setting_key === 'api_used') usage.used = parseInt(row.setting_value);
            if (row.setting_key === 'api_remaining') usage.remaining = parseInt(row.setting_value);
        });
        res.json({ success: true, data: usage });
    } catch (e) {
        res.json({ success: false });
    }
};

// ፋንክሽኑን መጨረሻ ላይ Export አድርገነዋል
module.exports = { manualSync, triggerSettlement, updateApiKey, getApiKey, getMatchesList, getApiUsage };