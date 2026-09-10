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
        await db.query(`INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES ('api_football_key', '')`);
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
        console.log(`\n🗑️ ያለቀው API Key ተሰርዟል!`);
    } catch (e) {}
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 🌟 የዓለምን ሊጎች እና ሙሉ ማርኬቶችን ማምጣት (Pro Plan Ultimate Fetcher) 🌟
const fetchAndSaveMatches = async () => {
    try {
        console.log(`\n⏳ ከ API-Football የዓለም ጨዋታዎችን ከነ-ሙሉ ማርኬታቸው በማምጣት ላይ... (ትንሽ ሊቆይ ይችላል)`);
        let totalSaved = 0;

        let apiKeys = await getApiKeysArray();
        if (apiKeys.length === 0) {
            console.error("❌ ምንም የሚሰራ API-Football Key የለም!");
            return false;
        }
        let API_KEY = apiKeys[0];
        const BASE_URL = 'https://v3.football.api-sports.io';
        const HEADERS = { 'x-apisports-key': API_KEY };

        // 1. በቀጣይ 4 ቀናት የሚደረጉ ጨዋታዎችን ቀናት እናዘጋጃለን
        const targetDates = [];
        for (let i = 0; i < 4; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            targetDates.push(d.toISOString().split('T')[0]); 
        }

        const allFixtures = [];
        const leaguesMap = new Map();

        // 2. የ 4 ቀናቱን ጨዋታዎች ሰብስበን የትኞቹ ሊጎች አክቲቭ (Active) እንደሆኑ እንለያለን
        for (const dateStr of targetDates) {
            try {
                const fixResp = await axios.get(`${BASE_URL}/fixtures`, {
                    headers: HEADERS, params: { date: dateStr }
                });
                
                if (fixResp.headers['x-ratelimit-requests-remaining']) {
                    const remaining = fixResp.headers['x-ratelimit-requests-remaining'];
                    const limit = fixResp.headers['x-ratelimit-requests-limit'];
                    await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_used', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [limit - remaining, limit - remaining]);
                    await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_remaining', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [remaining, remaining]);
                }

                if (fixResp.data.response) {
                    allFixtures.push(...fixResp.data.response);
                }
                await delay(250); 
            } catch (e) {
                if (e.response && e.response.status === 429) { await removeExhaustedKey(API_KEY); return false; }
            }
        }

        // ጨዋታ ያላቸውን ሊጎች ለይቶ ማውጣት
        allFixtures.forEach(fix => {
            const lId = fix.league.id;
            if (!leaguesMap.has(lId)) {
                leaguesMap.set(lId, {
                    id: lId,
                    season: fix.league.season,
                    name: fix.league.name || "League",
                    country: fix.league.country || "World",
                    flag: fix.league.flag || fix.league.logo || "https://media.api-sports.io/flags/un.svg",
                    logo: fix.league.logo,
                    fixtures: []
                });
            }
            leaguesMap.get(lId).fixtures.push(fix);
        });

        console.log(`📌 ጨዋታ ያላቸው ንቁ ሊጎች ብዛት: ${leaguesMap.size}`);

        // 3. ለእያንዳንዱ ሊግ ሙሉ ማርኬቶችን (All Markets) እንጎትታለን
        for (const [leagueId, leagueData] of leaguesMap.entries()) {
            try {
                const oddsMap = new Map();
                let page = 1;
                let totalPages = 1;

                // Pagination (ሁሉንም ገፆች እና ማርኬቶች ያመጣል)
                while (page <= totalPages) {
                    const oddsResp = await axios.get(`${BASE_URL}/odds`, {
                        headers: HEADERS, params: { league: leagueId, season: leagueData.season, bookmaker: 8, page: page }
                    });

                    if (oddsResp.data.response) {
                        oddsResp.data.response.forEach(odd => {
                            if (odd.bookmakers && odd.bookmakers.length > 0) oddsMap.set(odd.fixture.id, odd.bookmakers[0]);
                        });
                    }
                    totalPages = oddsResp.data.paging?.total || 1;
                    page++;
                    await delay(300); // Rate limit መከላከያ
                }

                let leagueSavedCount = 0;
                const sportKey = `${leagueData.country}|${leagueData.name}|${leagueData.flag}`;

                for (const fix of leagueData.fixtures) {
                    const bookmakerData = oddsMap.get(fix.fixture.id);
                    if (!bookmakerData || !bookmakerData.bets) continue;

                    const homeTeam = fix.teams.home.name;
                    const awayTeam = fix.teams.away.name;
                    
                    const finalBookmakers = [{ title: bookmakerData.name || "API-Football", markets: [] }];

                    // 🌟 በመቶዎች የሚቆጠሩትን ማርኬቶች በሙሉ አቅፎ ይይዛል 🌟
                    for (const bet of bookmakerData.bets) {
                        let marketKey = `market_${bet.id}`;
                        if (bet.id === 1) marketKey = 'h2h';
                        else if (bet.id === 12) marketKey = 'double_chance';
                        else if (bet.id === 5) marketKey = 'totals';
                        else if (bet.id === 8) marketKey = 'btts';

                        const outcomes = bet.values.map((v) => {
                            let name = v.value;
                            if (name === 'Home') name = homeTeam;
                            else if (name === 'Away') name = awayTeam;
                            else if (name === 'Home/Draw') name = '1X';
                            else if (name === 'Home/Away') name = '12';
                            else if (name === 'Draw/Away') name = 'X2';
                            return { name: name, price: parseFloat(v.odd) };
                        });

                        finalBookmakers[0].markets.push({ key: marketKey, title: bet.name, outcomes: outcomes });
                    }

                    if (finalBookmakers[0].markets.length > 0) {
                        const oddsDataStr = JSON.stringify(finalBookmakers);
                        const matchDate = new Date(fix.fixture.date);
                        const matchStatus = fix.fixture.status.short;
                        const homeLogo = fix.teams.home.logo;
                        const awayLogo = fix.teams.away.logo;
                        const leagueLogo = leagueData.flag; 

                        await db.query(`
                            INSERT INTO saved_matches 
                            (id, sport_key, home_team, away_team, commence_time, odds_data, league_logo, home_team_logo, away_team_logo, match_status) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
                            ON DUPLICATE KEY UPDATE 
                            odds_data = ?, commence_time = ?, match_status = ?, home_team_logo = ?, away_team_logo = ?, league_logo = ?
                        `, [
                            fix.fixture.id.toString(), sportKey, homeTeam, awayTeam, matchDate, oddsDataStr, 
                            leagueLogo, homeLogo, awayLogo, matchStatus,
                            oddsDataStr, matchDate, matchStatus, homeLogo, awayLogo, leagueLogo
                        ]);
                        
                        leagueSavedCount++; totalSaved++;
                    }
                }
                if (leagueSavedCount > 0) console.log(`✅ [${leagueData.country}] ${leagueData.name}: ${leagueSavedCount} ጨዋታዎች በስኬት ተቀምጠዋል`);
            } catch (err) {
                if (err.response && (err.response.status === 429 || err.response.status === 403)) {
                    await removeExhaustedKey(API_KEY); return false; 
                }
            }
        }
        console.log(`🎉 በአጠቃላይ ${totalSaved} የዓለም ጨዋታዎች ከነ-ሙሉ ማርኬታቸው ተጭነዋል!`);
        return true;
    } catch (error) { console.error("Fetch error:", error); return false; }
};

const runAutoSettlement = async () => {
    console.log("🔄 አውቶማቲክ የ API-Football ውጤት ማጣራት ተጀመረ...");
    try {
        const [pendingItems] = await db.query(`SELECT id, fixture_id, odd_name FROM ticket_items WHERE match_status = 'pending'`);
        if (pendingItems.length === 0) return;

        const fixtureIds = [...new Set(pendingItems.map(p => p.fixture_id))];
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
                            else if (opt.includes('Over 2.5')) isWon = (totalGoals > 2.5);
                            else if (opt.includes('Under 2.5')) isWon = (totalGoals < 2.5);
                            else if (opt === 'Yes' || opt.includes('GG')) isWon = (homeGoals > 0 && awayGoals > 0); 
                            else if (opt === 'No' || opt.includes('NG')) isWon = (homeGoals === 0 || awayGoals === 0);

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
