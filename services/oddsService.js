const db = require('../config/db');
const axios = require('axios');
const cron = require('node-cron');

const initializeDatabase = async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                setting_key VARCHAR(100) UNIQUE NOT NULL,
                setting_value VARCHAR(255) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        await db.query(`INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES ('api_football_key', 'YOUR_API_FOOTBALL_KEY_HERE')`);
    } catch (e) { }
};

const getApiKey = async () => {
    try {
        const [keys] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'api_football_key'");
        if (keys.length > 0 && keys[0].setting_value && !keys[0].setting_value.includes('ይቀይሩ')) {
            return keys[0].setting_value.trim();
        }
    } catch (e) { }
    return '';
};

const getApiKeysArray = async () => {
    try {
        const [keys] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'api_football_key'");
        if (keys.length > 0 && keys[0].setting_value && !keys[0].setting_value.includes('ይቀይሩ')) {
            return keys[0].setting_value.split(',').map(k => k.trim()).filter(k => k.length > 0);
        }
    } catch (e) { }
    return [];
};

const removeExhaustedKey = async (exhaustedKey) => {
    try {
        let keys = await getApiKeysArray();
        keys = keys.filter(k => k !== exhaustedKey);
        await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'api_football_key'", [keys.join(',')]);
        console.log(`\n🗑️ ያረጀው/ያለቀው API Key መረጃ ሰሌዳው ላይ ተሰርዟል!`);
    } catch (e) {}
};

// የ API-Football League IDs
const LEAGUES_MAP = {
    39: 'soccer_epl', 140: 'soccer_spain_la_liga', 135: 'soccer_italy_serie_a',
    78: 'soccer_germany_bundesliga', 61: 'soccer_france_ligue_one', 2: 'soccer_uefa_champs_league',
    3: 'soccer_uefa_europa_league', 88: 'soccer_netherlands_eredivisie', 94: 'soccer_portugal_primeira_liga',
    203: 'soccer_turkey_super_league', 253: 'soccer_usa_mls', 307: 'soccer_saudi_arabia_pro_league', 
    71: 'soccer_brazil_campeonato', 40: 'soccer_efl_champ'
};

const TARGET_LEAGUE_IDS = Object.keys(LEAGUES_MAP).map(Number);

const fetchAndSaveMatches = async () => {
    try {
        console.log(`\n⏳ ከ API-Football መረጃዎችን በማምጣት ላይ...`);
        let totalSaved = 0;

        let apiKeys = await getApiKeysArray();
        if (apiKeys.length === 0) {
            console.error("❌ ምንም የሚሰራ API-Football Key የለም! እባክዎ አድሚን ላይ አዲስ ያስገቡ።");
            return false;
        }
        let API_KEY = apiKeys[0];
        const BASE_URL = 'https://v3.football.api-sports.io';
        const HEADERS = { 'x-apisports-key': API_KEY };

        for (const leagueId of TARGET_LEAGUE_IDS) {
            try {
                // 1. የጨዋታ መርሃ-ግብሮችን (Fixtures) ማምጣት
                const fixResp = await axios.get(`${BASE_URL}/fixtures`, {
                    headers: HEADERS, params: { league: leagueId, next: 15 }
                });

                if (fixResp.headers['x-ratelimit-requests-remaining']) {
                    const remaining = fixResp.headers['x-ratelimit-requests-remaining'];
                    const limit = fixResp.headers['x-ratelimit-requests-limit'];
                    const used = parseInt(limit) - parseInt(remaining);
                    await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_used', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [used, used]);
                    await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_remaining', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [remaining, remaining]);
                }

                const fixtures = fixResp.data.response;
                if (!fixtures || fixtures.length === 0) continue;

                // 2. ኦዶችን (Odds) ማምጣት
                const season = fixtures[0].league.season;
                const oddsResp = await axios.get(`${BASE_URL}/odds`, {
                    headers: HEADERS, params: { league: leagueId, season: season, bookmaker: 8 }
                });

                const oddsMap = new Map();
                if (oddsResp.data.response) {
                    oddsResp.data.response.forEach((odd) => {
                        oddsMap.set(odd.fixture.id, odd.bookmakers[0]);
                    });
                }

                let leagueSavedCount = 0;

                // 3. ዳታውን ወደ ድሮው (The Odds API) ፎርማት ቀይሮ ማስገባት (ያለ Auto-Calc)
                for (const fix of fixtures) {
                    const fixId = fix.fixture.id;
                    const bookmakerData = oddsMap.get(fixId);
                    
                    if (bookmakerData && bookmakerData.bets) {
                        const homeTeam = fix.teams.home.name;
                        const awayTeam = fix.teams.away.name;
                        const sportKey = LEAGUES_MAP[leagueId] || `soccer_${leagueId}`;
                        
                        const finalBookmakers = [{ 
                            title: "API-Football", 
                            markets: [] 
                        }];

                        // 1X2 (Match Winner) -> ID: 1
                        const bet1X2 = bookmakerData.bets.find((b) => b.id === 1); 
                        if (bet1X2) {
                            const outcomes = bet1X2.values.map((v) => {
                                let name = v.value;
                                if (name === 'Home') name = homeTeam;
                                else if (name === 'Away') name = awayTeam;
                                return { name: name, price: parseFloat(v.odd) };
                            });
                            finalBookmakers[0].markets.push({ key: 'h2h', outcomes });
                        }

                        // Double Chance -> ID: 12
                        const betDC = bookmakerData.bets.find((b) => b.id === 12); 
                        if (betDC) {
                            const outcomes = betDC.values.map((v) => {
                                let name = v.value;
                                if (name === 'Home/Draw') name = '1X';
                                else if (name === 'Home/Away') name = '12';
                                else if (name === 'Draw/Away') name = 'X2';
                                return { name: name, price: parseFloat(v.odd) };
                            });
                            finalBookmakers[0].markets.push({ key: 'double_chance', outcomes });
                        }

                        // Over/Under (Totals) -> ID: 5
                        const betOU = bookmakerData.bets.find((b) => b.id === 5); 
                        if (betOU) {
                            const outcomes = betOU.values.map((v) => {
                                return { name: v.value, price: parseFloat(v.odd) };
                            });
                            finalBookmakers[0].markets.push({ key: 'totals', outcomes });
                        }

                        // Both Teams To Score (BTTS) -> ID: 8
                        const betBTTS = bookmakerData.bets.find((b) => b.id === 8); 
                        if (betBTTS) {
                            const outcomes = betBTTS.values.map((v) => {
                                return { name: v.value, price: parseFloat(v.odd) };
                            });
                            finalBookmakers[0].markets.push({ key: 'btts', outcomes });
                        }

                        // ቢያንስ 1X2 ኦድ ካለው ዳታቤዝ ውስጥ ይገባል
                        if (finalBookmakers[0].markets.length > 0) {
                            const oddsDataStr = JSON.stringify(finalBookmakers);
                            const matchDate = new Date(fix.fixture.date);
                            const matchStatus = fix.fixture.status.short;
                            const homeLogo = fix.teams.home.logo;
                            const awayLogo = fix.teams.away.logo;
                            const leagueLogo = fix.league.logo;

                            await db.query(`
                                INSERT INTO saved_matches 
                                (id, sport_key, home_team, away_team, commence_time, odds_data, league_logo, home_team_logo, away_team_logo, match_status) 
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
                                ON DUPLICATE KEY UPDATE 
                                odds_data = ?, commence_time = ?, match_status = ?, home_team_logo = ?, away_team_logo = ?
                            `, [
                                fixId.toString(), sportKey, homeTeam, awayTeam, matchDate, oddsDataStr, 
                                leagueLogo, homeLogo, awayLogo, matchStatus,
                                oddsDataStr, matchDate, matchStatus, homeLogo, awayLogo
                            ]);
                            
                            leagueSavedCount++; totalSaved++;
                        }
                    }
                }
                console.log(`✅ ${LEAGUES_MAP[leagueId]}: ${leagueSavedCount} ጨዋታዎች`);
            } catch (err) {
                if (err.response && (err.response.status === 429 || err.response.status === 403 || err.response.status === 401)) {
                    console.log(`\n⚠️ የ API ኮታ አልቋል ወይንም ተዘግቷል! አዲስ Key ያዘጋጁ...`);
                    await removeExhaustedKey(API_KEY);
                    return false; 
                }
            }
        }
        console.log(`🎉 በአጠቃላይ ${totalSaved} ጨዋታዎች መጥተዋል!`);
        return true;
    } catch (error) { return false; }
};

const runAutoSettlement = async () => {
    console.log("🔄 አውቶማቲክ የ API-Football ውጤት ማጣራት ተጀመረ...");
    try {
        const [pendingItems] = await db.query(`SELECT id, fixture_id, odd_name FROM ticket_items WHERE match_status = 'pending'`);

        if (pendingItems.length === 0) {
            console.log("✅ ምንም የሚጣራ Pending ትኬት የለም (API ጥያቄ አልተላከም)።");
            return;
        }

        const fixtureIds = [...new Set(pendingItems.map(p => p.fixture_id))];
        console.log(`📌 የሚጣሩ የጨዋታዎች ብዛት: ${fixtureIds.length}`);

        let apiKeys = await getApiKeysArray();
        if (apiKeys.length === 0) return;
        let API_KEY = apiKeys[0];
        const HEADERS = { 'x-apisports-key': API_KEY };

        const chunkedIds = [];
        for (let i = 0; i < fixtureIds.length; i += 20) {
            chunkedIds.push(fixtureIds.slice(i, i + 20));
        }

        for (const idsChunk of chunkedIds) {
            try {
                const resp = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
                    headers: HEADERS, params: { ids: idsChunk.join('-') }
                });

                for (const match of resp.data.response) {
                    const status = match.fixture.status.short;
                    const isCompleted = ['FT', 'PEN', 'AET'].includes(status);
                    
                    await db.query(`UPDATE saved_matches SET match_status = ? WHERE id = ?`, [status, match.fixture.id.toString()]);

                    if (isCompleted) {
                        const homeGoals = match.goals.home || 0;
                        const awayGoals = match.goals.away || 0;
                        const totalGoals = homeGoals + awayGoals;
                        const scoreStr = `${homeGoals}-${awayGoals}`; 

                        const associatedPicks = pendingItems.filter(p => p.fixture_id == match.fixture.id);
                        
                        for (let pick of associatedPicks) {
                            let isWon = false;
                            const opt = pick.odd_name.toString().trim();

                            if (opt === '1' || opt === match.teams.home.name) isWon = (homeGoals > awayGoals);
                            else if (opt === 'X' || opt === 'Draw') isWon = (homeGoals === awayGoals);
                            else if (opt === '2' || opt === match.teams.away.name) isWon = (homeGoals < awayGoals);
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

                            await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", [isWon ? 'won' : 'lost', scoreStr, pick.id]);
                        }
                    }
                }
            } catch (err) {
                if (err.response && (err.response.status === 429 || err.response.status === 403)) {
                    await removeExhaustedKey(API_KEY);
                }
            }
        }

        await db.query(`UPDATE tickets t SET status = 'lost' WHERE status = 'active' AND EXISTS (SELECT 1 FROM ticket_items ti WHERE ti.ticket_id = t.id AND ti.match_status = 'lost')`);
        await db.query(`UPDATE tickets t SET status = 'won' WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM ticket_items ti WHERE ti.ticket_id = t.id AND ti.match_status != 'won')`);
        
    } catch (error) { }
};

const startCronJobs = () => {
    initializeDatabase();
    cron.schedule('0 */4 * * *', fetchAndSaveMatches); 
    cron.schedule('*/15 * * * *', runAutoSettlement);  
    cron.schedule('0 * * * *', async () => {
        try { await db.query(`UPDATE tickets SET status = 'expired' WHERE status = 'won' AND created_at < NOW() - INTERVAL 48 HOUR`); } catch (e) {}
    });
};

module.exports = { startCronJobs, fetchAndSaveMatches, runAutoSettlement, getApiKey };
