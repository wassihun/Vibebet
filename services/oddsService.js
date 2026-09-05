const db = require('../config/db');
const axios = require('axios');
const cron = require('node-cron');

const initializeDatabase = async () => {
    try {
        await db.query("ALTER TABLE ticket_items ADD COLUMN match_status VARCHAR(20) DEFAULT 'pending'");
    } catch (e) { }
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                setting_key VARCHAR(100) UNIQUE NOT NULL,
                setting_value VARCHAR(255) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        await db.query(`INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES ('odds_api_key', 'YOUR_ODDS_API_KEY_HERE')`);
    } catch (e) { }
};

// ወደ አድሚን ገፅ (Frontend) Array አድርጎ ለማሳየት እና ለማስተካከል ያገለግላል
const getApiKey = async () => {
    try {
        const [keys] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'odds_api_key'");
        if (keys.length > 0 && keys[0].setting_value && !keys[0].setting_value.includes('ይቀይሩ')) {
            return keys[0].setting_value.trim();
        }
    } catch (e) { }
    return '';
};

// 🌟 አዲስ፡ በኮማ (,) የተለዩትን Keys ወደ Array ይቀይረዋል 🌟
const getApiKeysArray = async () => {
    try {
        const [keys] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'odds_api_key'");
        if (keys.length > 0 && keys[0].setting_value && !keys[0].setting_value.includes('ይቀይሩ')) {
            return keys[0].setting_value.split(',').map(k => k.trim()).filter(k => k.length > 0);
        }
    } catch (e) { }
    return [];
};

// 🌟 አዲስ፡ ያረጀውን / ያለቀውን API Key ከዳታቤዙ ላይ ሙሉ በሙሉ ይሰርዛል 🌟
const removeExhaustedKey = async (exhaustedKey) => {
    try {
        let keys = await getApiKeysArray();
        keys = keys.filter(k => k !== exhaustedKey);
        await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'odds_api_key'", [keys.join(',')]);
        console.log(`\n🗑️ ያረጀው/ያለቀው API Key መረጃ ሰሌዳው ላይ ተሰርዟል!`);
    } catch (e) {}
};

const TARGET_LEAGUES = [
    'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a', 'soccer_germany_bundesliga',
    'soccer_france_ligue_one', 'soccer_uefa_champs_league', 'soccer_uefa_europa_league',
    'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga', 'soccer_turkey_super_league',
    'soccer_usa_mls', 'soccer_saudi_arabia_pro_league', 'soccer_spl', 'soccer_brazil_campeonato',
    'soccer_efl_champ', 'soccer_spain_segunda_division', 'soccer_italy_serie_b',
    'soccer_germany_bundesliga2', 'soccer_france_ligue_two'
];

const fetchAndSaveMatches = async () => {
    try {
        console.log(`\n⏳ ከ The Odds API ዋና ኦዶችን በማምጣት ላይ...`);
        let totalSaved = 0;

        for (const league of TARGET_LEAGUES) {
            let success = false;
            
            // 🌟 አዲስ፡ ትክክለኛ እና የሚሰራ Key እስኪያገኝ ድረስ ይሞክራል 🌟
            while (!success) {
                let apiKeys = await getApiKeysArray();
                if (apiKeys.length === 0) {
                    console.error("❌ ምንም የሚሰራ Odds API Key የለም! እባክዎ አድሚን ላይ አዲስ ያስገቡ።");
                    return false;
                }
                
                // ሁልጊዜም ከላይ ያለውን (የመጀመሪያውን) ቁልፍ ይጠቀማል
                let API_KEY = apiKeys[0];

                try {
                    const resp = await axios.get(`https://api.the-odds-api.com/v4/sports/${league}/odds`, {
                        params: { apiKey: API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' }
                    });

                    if (resp.headers['x-requests-used'] && resp.headers['x-requests-remaining']) {
                        const used = resp.headers['x-requests-used'];
                        const remaining = resp.headers['x-requests-remaining'];
                        await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_used', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [used, used]);
                        await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_remaining', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [remaining, remaining]);
                    }

                    let leagueSavedCount = 0;
                    for (let match of resp.data || []) {
                        if (match.bookmakers && match.bookmakers.length > 0) {
                            const finalBookmakers = [{ title: "The Odds API (Auto-Generated)", markets: [] }];
                            const bookmakerData = match.bookmakers[0]; 

                            const h2hMarket = bookmakerData.markets.find(m => m.key === 'h2h');
                            if (h2hMarket) {
                                let odd1 = 0, oddX = 0, odd2 = 0;

                                const outcomes = h2hMarket.outcomes.map(o => {
                                    const price = parseFloat(o.price);
                                    if (o.name === match.home_team) odd1 = price;
                                    else if (o.name === 'Draw') oddX = price;
                                    else if (o.name === match.away_team) odd2 = price;

                                    return {
                                        name: o.name === match.home_team ? match.home_team : o.name === 'Draw' ? 'Draw' : match.away_team,
                                        price: price
                                    };
                                });

                                finalBookmakers[0].markets.push({ key: 'h2h', outcomes });

                                const margin = 0.90; 
                                if (odd1 > 0 && oddX > 0 && odd2 > 0) {
                                    const dc1X = ((odd1 * oddX) / (odd1 + oddX)) * margin;
                                    const dc12 = ((odd1 * odd2) / (odd1 + odd2)) * margin;
                                    const dcX2 = ((oddX * odd2) / (oddX + odd2)) * margin;

                                    finalBookmakers[0].markets.push({
                                        key: 'double_chance',
                                        outcomes: [
                                            { name: '1X', price: parseFloat(dc1X.toFixed(2)) },
                                            { name: '12', price: parseFloat(dc12.toFixed(2)) },
                                            { name: 'X2', price: parseFloat(dcX2.toFixed(2)) }
                                        ]
                                    });

                                    let over25 = 1.85, under25 = 1.85;
                                    const favOdd = Math.min(odd1, odd2);
                                    if (favOdd < 1.40) { over25 = 1.55; under25 = 2.30; }
                                    else if (favOdd < 1.80) { over25 = 1.75; under25 = 1.95; }
                                    else { over25 = 2.05; under25 = 1.65; }

                                    finalBookmakers[0].markets.push({
                                        key: 'totals',
                                        outcomes: [
                                            { name: 'Over 2.5', price: over25 },
                                            { name: 'Under 2.5', price: under25 }
                                        ]
                                    });

                                    let bttsYes = 1.85, bttsNo = 1.85;
                                    if (oddX < 3.20) { bttsYes = 1.65; bttsNo = 2.10; }
                                    else if (favOdd < 1.40) { bttsYes = 2.15; bttsNo = 1.60; }

                                    finalBookmakers[0].markets.push({
                                        key: 'btts',
                                        outcomes: [
                                            { name: 'Yes', price: bttsYes },
                                            { name: 'No', price: bttsNo }
                                        ]
                                    });
                                }
                            }

                            if (finalBookmakers[0].markets.length > 0) {
                                const oddsDataStr = JSON.stringify(finalBookmakers);
                                await db.query(`
                                    INSERT INTO saved_matches (id, sport_key, home_team, away_team, commence_time, odds_data) 
                                    VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE odds_data = ?, commence_time = ?
                                `, [match.id, league, match.home_team, match.away_team, new Date(match.commence_time), oddsDataStr, oddsDataStr, new Date(match.commence_time)]);
                                leagueSavedCount++; totalSaved++;
                            }
                        }
                    }
                    console.log(`✅ ${league}: ${leagueSavedCount} ጨዋታዎች`);
                    success = true; 
                } catch (err) {
                    // 🌟 አዲስ፡ ኮታ ካለቀ (429) ከዳታቤዝ ላይ ይሰርዘውና ድጋሚ (while loop) ይሞክራል 🌟
                    if (err.response && (err.response.status === 429 || err.response.status === 401)) {
                        console.log(`\n⚠️ የ API ኮታ አልቋል ወይንም ተዘግቷል! ወደሚቀጥለው እየተቀየረ ነው...`);
                        await removeExhaustedKey(API_KEY);
                    } else {
                        success = true; // ሌላ አይነት (Network error) ከሆነ ያሳልፈዋል
                    }
                }
            }
        }
        console.log(`🎉 በአጠቃላይ ${totalSaved} ጨዋታዎች መጥተዋል!`);
        return true;
    } catch (error) { return false; }
};

const runAutoSettlement = async () => {
    console.log("🔄 አውቶማቲክ ውጤት ማጣራት ተጀመረ...");
    try {
        const [pendingLeagues] = await db.query(`
            SELECT DISTINCT s.sport_key 
            FROM ticket_items ti 
            JOIN saved_matches s ON ti.fixture_id = s.id 
            WHERE ti.match_status = 'pending'
        `);

        if (pendingLeagues.length === 0) {
            console.log("✅ ምንም የሚጣራ Pending ትኬት የለም (API ጥያቄ አልተላከም)።");
            return;
        }

        const leaguesToCheck = pendingLeagues.map(row => row.sport_key).filter(Boolean);
        console.log(`📌 የሚጣሩ የPending ሊጎች ብዛት: ${leaguesToCheck.length}`);

        const [pendingItems] = await db.query(`SELECT id, fixture_id, odd_name FROM ticket_items WHERE match_status = 'pending'`);

        for (const league of leaguesToCheck) {
            let success = false;
            
            while (!success) {
                let apiKeys = await getApiKeysArray();
                if (apiKeys.length === 0) {
                    console.error("❌ ምንም የሚሰራ Odds API Key የለም! ውጤት ማጣራት ቆሟል።");
                    return;
                }
                
                let API_KEY = apiKeys[0];

                try {
                    const resp = await axios.get(`https://api.the-odds-api.com/v4/sports/${league}/scores`, { params: { apiKey: API_KEY, daysFrom: 3 } });
                    
                    if (resp.headers['x-requests-used'] && resp.headers['x-requests-remaining']) {
                        const used = resp.headers['x-requests-used'];
                        const remaining = resp.headers['x-requests-remaining'];
                        await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_used', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [used, used]);
                        await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_remaining', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [remaining, remaining]);
                    }

                    const completedMatches = resp.data.filter(m => m.completed === true);

                    for (let match of completedMatches) {
                        const homeScoreObj = match.scores?.find(s => s.name === match.home_team);
                        const awayScoreObj = match.scores?.find(s => s.name === match.away_team);
                        const homeGoals = homeScoreObj ? parseInt(homeScoreObj.score) : 0;
                        const awayGoals = awayScoreObj ? parseInt(awayScoreObj.score) : 0;
                        const totalGoals = homeGoals + awayGoals;

                        const associatedPicks = pendingItems.filter(p => p.fixture_id === match.id);
                        if (associatedPicks.length > 0) {
                            for (let pick of associatedPicks) {
                                let isWon = false;
                                const opt = pick.odd_name.toString().trim();

                                if (opt === '1' || opt === match.home_team) isWon = (homeGoals > awayGoals);
                                else if (opt === 'X' || opt === 'Draw') isWon = (homeGoals === awayGoals);
                                else if (opt === '2' || opt === match.away_team) isWon = (homeGoals < awayGoals);
                                else if (opt === '1X') isWon = (homeGoals >= awayGoals);
                                else if (opt === '12') isWon = (homeGoals !== awayGoals);
                                else if (opt === 'X2') isWon = (homeGoals <= awayGoals);
                                else if (opt.includes('Over 1.5')) isWon = (totalGoals > 1.5);
                                else if (opt.includes('Under 1.5')) isWon = (totalGoals < 1.5);
                                else if (opt.includes('Over 2.5')) isWon = (totalGoals > 2.5);
                                else if (opt.includes('Under 2.5')) isWon = (totalGoals < 2.5);
                                else if (opt.includes('Over 3.5')) isWon = (totalGoals > 3.5);
                                else if (opt.includes('Under 3.5')) isWon = (totalGoals < 3.5);
                                else if (opt === 'Yes') isWon = (homeGoals > 0 && awayGoals > 0); 
                                else if (opt === 'No') isWon = (homeGoals === 0 || awayGoals === 0);
                                else if (opt.includes('Odd')) isWon = (totalGoals % 2 !== 0);
                                else if (opt.includes('Even')) isWon = (totalGoals % 2 === 0);

                                await db.query("UPDATE ticket_items SET match_status = ? WHERE id = ?", [isWon ? 'won' : 'lost', pick.id]);
                            }
                        }
                    }
                    success = true; 
                } catch (err) {
                    if (err.response && (err.response.status === 429 || err.response.status === 401)) {
                        console.log(`\n⚠️ የ API ኮታ አልቋል ወይንም ተዘግቷል! ወደሚቀጥለው እየተቀየረ ነው...`);
                        await removeExhaustedKey(API_KEY);
                    } else {
                        success = true; 
                    }
                }
            }
        }
        await db.query(`UPDATE tickets t SET status = 'lost' WHERE status = 'active' AND EXISTS (SELECT 1 FROM ticket_items ti WHERE ti.ticket_id = t.id AND ti.match_status = 'lost')`);
        await db.query(`UPDATE tickets t SET status = 'won' WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM ticket_items ti WHERE ti.ticket_id = t.id AND ti.match_status != 'won')`);
    } catch (error) { }
};

const startCronJobs = () => {
    initializeDatabase();
    cron.schedule('0 */12 * * *', fetchAndSaveMatches); 
    cron.schedule('*/30 * * * *', runAutoSettlement);  
    cron.schedule('0 * * * *', async () => {
        try { await db.query(`UPDATE tickets SET status = 'expired' WHERE status = 'won' AND created_at < NOW() - INTERVAL 48 HOUR`); } catch (e) {}
    });
};

module.exports = { startCronJobs, fetchAndSaveMatches, runAutoSettlement, getApiKey };