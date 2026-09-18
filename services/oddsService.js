const db = require('../config/db');
const axios = require('axios');
const cron = require('node-cron');

const initializeDatabase = async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                setting_key VARCHAR(100) UNIQUE NOT NULL,
                setting_value TEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        await db.query(`INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES ('api_football_key', '')`);
        try { await db.query(`ALTER TABLE system_settings MODIFY setting_value TEXT NOT NULL`); } catch (e) {}
    } catch (e) { console.error("Database Init Error:", e); }
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

const createApiClient = (initialKeys, baseUrl) => {
    let apiKeys = [...initialKeys];
    let currentKey = apiKeys[0];
    let headers = { 'x-apisports-key': currentKey };
    let requestsRemaining = Infinity;

    const rotate = async () => {
        await removeExhaustedKey(currentKey);
        apiKeys = apiKeys.filter(k => k !== currentKey);
        if (apiKeys.length === 0) return false;
        currentKey = apiKeys[0];
        headers = { 'x-apisports-key': currentKey };
        return true;
    };

    const trackUsage = async (respHeaders) => {
        if (respHeaders['x-ratelimit-requests-remaining'] === undefined) return;
        const remaining = parseInt(respHeaders['x-ratelimit-requests-remaining'], 10);
        const limit = parseInt(respHeaders['x-ratelimit-requests-limit'], 10);
        requestsRemaining = remaining;
        try {
            const used = limit - remaining;
            await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_used', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [used, used]);
            await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_remaining', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [remaining, remaining]);
        } catch (e) {}
    };

    const get = async (path, params) => {
        while (true) {
            try {
                const resp = await axios.get(`${baseUrl}${path}`, { headers, params });
                await trackUsage(resp.headers);
                return resp;
            } catch (err) {
                const status = err.response && err.response.status;
                if (status === 429 || status === 403 || status === 401) {
                    console.log(`\n⚠️ Key ኮታ አልቋል/ተዘግቷል (${path}) — ወደሚቀጥለው Key በመቀየር ላይ...`);
                    const rotated = await rotate();
                    if (!rotated) throw err; 
                    continue; 
                }
                throw err; 
            }
        }
    };

    return { get, remaining: () => requestsRemaining, hasKeys: () => apiKeys.length > 0 };
};

// 🌟 1. የሀገራት እና የሊጎች ፍፁም የሆነ ትስስር (100% Exact ID Mapping) 🌟
const exactTopLeagues = {
    2:   { name: 'UEFA Champions League', country: 'Europe' },
    3:   { name: 'UEFA Europa League', country: 'Europe' },
    848: { name: 'UEFA Conference League', country: 'Europe' },
    4:   { name: 'Euro Championship', country: 'Europe' },
    15:  { name: 'World Cup', country: 'World' },
    9:   { name: 'Copa America', country: 'South America' },
    6:   { name: 'Africa Cup of Nations', country: 'Africa' },
    39:  { name: 'Premier League', country: 'England' },
    40:  { name: 'Championship', country: 'England' },
    45:  { name: 'FA Cup', country: 'England' },
    48:  { name: 'EFL Cup', country: 'England' }, // Carabao Cup
    140: { name: 'La Liga', country: 'Spain' },
    143: { name: 'Copa del Rey', country: 'Spain' },
    135: { name: 'Serie A', country: 'Italy' },
    137: { name: 'Coppa Italia', country: 'Italy' },
    78:  { name: 'Bundesliga', country: 'Germany' },
    81:  { name: 'DFB Pokal', country: 'Germany' },
    61:  { name: 'Ligue 1', country: 'France' },
    66:  { name: 'Coupe de France', country: 'France' },
    132: { name: "UEFA Women's Champions League", country: 'Europe' }
};

const topLeagueIds = Object.keys(exactTopLeagues).map(Number);

const getStandardSportKey = (league) => {
    const safeFlag = String(league.flag || league.logo || 'https://media.api-sports.io/flags/un.svg').trim();

    if (exactTopLeagues[league.id]) {
        const exact = exactTopLeagues[league.id];
        return `${exact.country}|${exact.name}|${safeFlag}`;
    }

    const safeCountry = String(league.country || 'World').trim().replace(/\|/g, '');
    const safeLeague = String(league.name || 'League').trim().replace(/\|/g, '');

    return `${safeCountry}|${safeLeague}|${safeFlag}`;
};

// 🌟 2. እጅግ ጥብቅ የሆነ ማጣሪያ (Premium Filter) 🌟
const isLeagueAllowed = (league, dayOffset) => {
    if (!league || !league.name || !league.country) return false;
    
    // 1. ታላላቆቹን (EFL Cup, FA Cup, UCL) ያለ ምንም ገደብ አሳልፍ!
    if (topLeagueIds.includes(league.id)) return true; 

    const name = league.name.toLowerCase();
    const country = league.country.toLowerCase();

    // 2. BLACKLIST: ወጣቶች፣ ተጠባባቂዎች እና አማተሮች አይገቡም
    const blacklist = ['u19', 'u20', 'u21', 'u22', 'u23', 'reserve', 'amateur', 'youth', 'regional', 'state'];
    if (blacklist.some(b => name.includes(b))) return false;

    // 3. INTERNATIONAL (ዓለም አቀፍ ውድድሮች እና የሴቶች አህጉራዊ)
    const intlRegions = ['world', 'europe', 'africa', 'asia', 'south america', 'north america', 'oceania'];
    if (intlRegions.includes(country)) {
        if (name.includes('qualifying') || name.includes('qualification')) {
            // የዓለም ዋንጫ፣ ዩሮ እና አፍሪካ ዋንጫ ማጣሪያዎች ብቻ ይፈቀዳሉ
            if (name.includes('world cup') || name.includes('euro') || name.includes('africa')) return true;
            return false;
        }
        return true; 
    }

    // 4. TOP 5 COUNTRIES (Minor Leagues limitation)
    const topCountries = ['england', 'spain', 'italy', 'germany', 'france'];
    if (topCountries.includes(country)) {
        const topBlacklist = ['league two', 'national league', 'tercera', 'serie d', 'regionalliga', 'oberliga', 'national 2', 'national 3', 'non league', 'trophy', 'qualifying', 'qualification'];
        if (topBlacklist.some(b => name.includes(b))) return false;
        return true;
    }

    // 5. OTHER COUNTRIES (1ኛ ዲቪዚዮን ብቻ እንዲመጣ 2ኛ፣ 3ኛ እና ካፕ እናግዳለን)
    const lowerDivisionRegex = /\b(2|3|4|ii|iii|iv|b|second|third|fourth|challenge|play-offs|cup|super cup|league cup|shield)\b/i;
    if (lowerDivisionRegex.test(name)) return false; 

    // 6. MINOR LEAGUES 14-DAY LIMIT
    if (dayOffset >= 14) return false; 

    return true; 
};

const buildOddsPayload = (bookmakerData, homeTeam, awayTeam) => {
    if (!bookmakerData || !bookmakerData.bets) return '[]';

    const finalBookmakers = [{ title: bookmakerData.name || 'API-Football Bookmaker', markets: [] }];

    for (const bet of bookmakerData.bets) {
        if (!bet.values) continue;

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
            return { name, price: parseFloat(v.odd) };
        });

        finalBookmakers[0].markets.push({ key: marketKey, title: bet.name, outcomes });
    }

    return finalBookmakers[0].markets.length > 0 ? JSON.stringify(finalBookmakers) : '[]';
};

const upsertMatch = async (fix, sportKey, bookmakerData) => {
    try {
        const homeTeam = fix.teams?.home?.name || 'Home Team';
        const awayTeam = fix.teams?.away?.name || 'Away Team';
        const oddsDataStr = buildOddsPayload(bookmakerData, homeTeam, awayTeam);
        
        // 🚨 ኦድ ከሌለው አታስገባም!
        if (oddsDataStr === '[]') return false;

        const matchDate = new Date(fix.fixture.date);
        const matchStatus = fix.fixture.status.short;
        const homeLogo = fix.teams?.home?.logo || '';
        const awayLogo = fix.teams?.away?.logo || '';
        const leagueLogo = fix.league?.logo || '';

        await db.query(`
            INSERT INTO saved_matches
            (id, sport_key, home_team, away_team, commence_time, odds_data, league_logo, home_team_logo, away_team_logo, match_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                sport_key = VALUES(sport_key),
                commence_time = VALUES(commence_time),
                match_status = VALUES(match_status),
                home_team_logo = VALUES(home_team_logo),
                away_team_logo = VALUES(away_team_logo),
                league_logo = VALUES(league_logo),
                odds_data = VALUES(odds_data)
        `, [
            fix.fixture.id.toString(), sportKey, homeTeam, awayTeam, matchDate, oddsDataStr,
            leagueLogo, homeLogo, awayLogo, matchStatus
        ]);

        return true;
    } catch (e) {
        console.error(`   ⚠️ Fixture ${fix.fixture?.id} ማስቀመጥ አልተቻለም: ${e.message}`);
        return false;
    }
};

const fetchAndSaveMatches = async () => {
    try {
        console.log(`\n⏳ ከ API-Football ጥርት ያሉ ጨዋታዎችን በማምጣት ላይ... (Hybrid Pro Mode)`);
        let totalWithOdds = 0;

        const apiKeys = await getApiKeysArray();
        if (apiKeys.length === 0) {
            console.error("❌ ምንም የሚሰራ API-Football Key የለም!");
            return false;
        }

        const BASE_URL = 'https://v3.football.api-sports.io';
        const client = createApiClient(apiKeys, BASE_URL);

        const targetDates = [];
        for (let i = 0; i < 30; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            targetDates.push({ dateStr: d.toISOString().split('T')[0], dayOffset: i });
        }

        try { await db.query(`DELETE FROM saved_matches WHERE odds_data = '[]' OR odds_data IS NULL`); } catch (e) {}

        for (const { dateStr, dayOffset } of targetDates) {
            if (client.remaining() < 50) break;

            try {
                console.log(`📅 የ ${dateStr} ጨዋታዎችን በማጣራት ላይ...`);
                
                const fixResp = await client.get('/fixtures', { date: dateStr });
                const allFixtures = fixResp.data.response || [];
                
                const validFixtures = allFixtures.filter(fix => isLeagueAllowed(fix.league, dayOffset));
                if (validFixtures.length === 0) continue;

                const fixturesMap = new Map(validFixtures.map(f => [f.fixture.id, f]));
                const oddsMap = new Map();

                const targetBookies = [8, 11, 17];
                for (const bookieId of targetBookies) {
                    if (oddsMap.size >= validFixtures.length) break; 
                    
                    let page = 1, totalPages = 1;
                    while (page <= totalPages) {
                        if (client.remaining() < 20) break;
                        try {
                            const oddsResp = await client.get('/odds', { date: dateStr, page, bookmaker: bookieId });
                            (oddsResp.data.response || []).forEach(odd => {
                                if (fixturesMap.has(odd.fixture.id) && !oddsMap.has(odd.fixture.id) && odd.bookmakers?.length > 0) {
                                    oddsMap.set(odd.fixture.id, odd.bookmakers[0]);
                                }
                            });
                            totalPages = oddsResp.data.paging?.total || 1;
                            page++;
                            await delay(250);
                        } catch (e) { page++; await delay(800); }
                    }
                }

                // 🌟🌟 ነጥሎ አዳኝ (Sniper Mode for Top Leagues) 🌟🌟
                const missingTopFixtures = validFixtures
                    .filter(f => topLeagueIds.includes(f.league.id))
                    .filter(f => !oddsMap.has(f.fixture.id));

                for (const missingFix of missingTopFixtures) {
                    if (client.remaining() < 10) break;
                    try {
                        console.log(`   🎯 የተደበቀ ታላቅ ጨዋታ ነጥሎ በመፈለግ ላይ: ${missingFix.teams.home.name} vs ${missingFix.teams.away.name}`);
                        const oddsResp = await client.get('/odds', { fixture: missingFix.fixture.id });
                        const oddData = oddsResp.data.response?.[0];
                        if (oddData && oddData.bookmakers?.length > 0) {
                            const bestBm = oddData.bookmakers.find(b => b.id === 8) 
                                        || oddData.bookmakers.find(b => b.id === 11) 
                                        || oddData.bookmakers[0];
                            oddsMap.set(missingFix.fixture.id, bestBm);
                        }
                        await delay(300);
                    } catch (e) { await delay(800); }
                }

                let dailySaved = 0;
                for (const [fixtureId, bookmakerData] of oddsMap.entries()) {
                    const fix = fixturesMap.get(fixtureId);
                    if (!fix) continue;

                    const sportKey = getStandardSportKey(fix.league);
                    const ok = await upsertMatch(fix, sportKey, bookmakerData);
                    if (ok) { dailySaved++; totalWithOdds++; }
                }

                if (dailySaved > 0) console.log(`✅ ${dateStr}: ${dailySaved} ጨዋታዎች ተቀምጠዋል`);

            } catch (err) { console.error(`⚠️ ${dateStr} ማምጣት አልተቻለም`); }
        }

        console.log(`\n🎉 በአጠቃላይ ${totalWithOdds} የተጣሩ እና ኦድ ያላቸው ጨዋታዎች ተመዝግበዋል!`);
        return true;
    } catch (error) { return false; }
};

const runAutoSettlement = async () => {
    try {
        const [pendingItems] = await db.query(`SELECT id, fixture_id, odd_name FROM ticket_items WHERE match_status = 'pending'`);
        if (pendingItems.length === 0) return;

        const fixtureIds = [...new Set(pendingItems.map(p => p.fixture_id))];
        const apiKeys = await getApiKeysArray();
        if (apiKeys.length === 0) return;

        const client = createApiClient(apiKeys, 'https://v3.football.api-sports.io');

        const chunkedIds = [];
        for (let i = 0; i < fixtureIds.length; i += 20) {
            chunkedIds.push(fixtureIds.slice(i, i + 20));
        }

        for (const idsChunk of chunkedIds) {
            if (!client.hasKeys()) break;
            try {
                const resp = await client.get('/fixtures', { ids: idsChunk.join('-') });

                for (const match of resp.data.response) {
                    const status = match.fixture.status.short;

                    const isCompleted = ['FT', 'PEN', 'AET'].includes(status);
                    const isCancelledOrPostponed = ['PST', 'CANC', 'ABD', 'WO'].includes(status);

                    await db.query(`UPDATE saved_matches SET match_status = ? WHERE id = ?`, [status, match.fixture.id.toString()]);

                    const associatedPicks = pendingItems.filter(p => p.fixture_id == match.fixture.id);

                    if (isCancelledOrPostponed) {
                        for (let pick of associatedPicks) {
                            await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", ['postponed', 'Postponed', pick.id]);
                        }
                        continue;
                    }

                    if (isCompleted) {
                        const ftHome = match.score?.fulltime?.home;
                        const ftAway = match.score?.fulltime?.away;

                        const homeGoals = ftHome !== null && ftHome !== undefined ? ftHome : (match.goals?.home || 0);
                        const awayGoals = ftAway !== null && ftAway !== undefined ? ftAway : (match.goals?.away || 0);

                        const totalGoals = homeGoals + awayGoals;
                        const scoreStr = `${homeGoals}-${awayGoals}`;

                        const homeName = match.teams?.home?.name || "Home";
                        const awayName = match.teams?.away?.name || "Away";

                        for (let pick of associatedPicks) {
                            let isWon = false;
                            const opt = pick.odd_name.toString().trim();
                            const optLower = opt.toLowerCase();

                            if (opt === '1' || opt === homeName) isWon = (homeGoals > awayGoals);
                            else if (opt === 'X' || opt === 'Draw') isWon = (homeGoals === awayGoals);
                            else if (opt === '2' || opt === awayName) isWon = (homeGoals < awayGoals);
                            else if (opt === '1X') isWon = (homeGoals >= awayGoals);
                            else if (opt === '12') isWon = (homeGoals !== awayGoals);
                            else if (opt === 'X2') isWon = (homeGoals <= awayGoals);
                            else if (optLower.includes('over')) {
                                const matchNum = optLower.match(/\d+(\.\d+)?/);
                                if (matchNum) isWon = (totalGoals > parseFloat(matchNum[0]));
                            }
                            else if (optLower.includes('under')) {
                                const matchNum = optLower.match(/\d+(\.\d+)?/);
                                if (matchNum) isWon = (totalGoals < parseFloat(matchNum[0]));
                            }
                            else if (opt === 'Yes' || opt.includes('GG')) isWon = (homeGoals > 0 && awayGoals > 0);
                            else if (opt === 'No' || opt.includes('NG')) isWon = (homeGoals === 0 || awayGoals === 0);

                            await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", [isWon ? 'won' : 'lost', scoreStr, pick.id]);
                        }
                    }
                }
            } catch (err) { }
        }

        await db.query(`UPDATE tickets t SET status = 'lost' WHERE status = 'active' AND EXISTS (SELECT 1 FROM ticket_items ti WHERE ti.ticket_id = t.id AND ti.match_status = 'lost')`);

    } catch (error) { }
};

const startCronJobs = () => {
    initializeDatabase();
    cron.schedule('0 */4 * * *', fetchAndSaveMatches);
    cron.schedule('*/15 * * * *', runAutoSettlement);
    cron.schedule('0 * * * *', async () => {
        try { await db.query(`UPDATE tickets SET status = 'expired' WHERE status = 'won' AND created_at < NOW() - INTERVAL 72 HOUR`); } catch (e) {}
    });
};

module.exports = { startCronJobs, fetchAndSaveMatches, runAutoSettlement, getApiKey };