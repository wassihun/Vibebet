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
    48:  { name: 'EFL Cup', country: 'England' },
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

const isLeagueAllowed = (league, dayOffset) => {
    if (!league || !league.name || !league.country) return false;
    
    if (topLeagueIds.includes(league.id)) return true; 

    const name = league.name.toLowerCase();
    const country = league.country.toLowerCase();

    const blacklist = ['u19', 'u20', 'u21', 'u22', 'u23', 'reserve', 'amateur', 'youth', 'regional', 'state'];
    if (blacklist.some(b => name.includes(b))) return false;

    const intlRegions = ['world', 'europe', 'africa', 'asia', 'south america', 'north america', 'oceania'];
    if (intlRegions.includes(country)) {
        if (name.includes('qualifying') || name.includes('qualification')) {
            if (name.includes('world cup') || name.includes('euro') || name.includes('africa')) return true;
            return false;
        }
        return true; 
    }

    const topCountries = ['england', 'spain', 'italy', 'germany', 'france'];
    if (topCountries.includes(country)) {
        const topBlacklist = ['league two', 'national league', 'tercera', 'serie d', 'regionalliga', 'oberliga', 'national 2', 'national 3', 'non league', 'trophy', 'qualifying', 'qualification'];
        if (topBlacklist.some(b => name.includes(b))) return false;
        return true;
    }

    const lowerDivisionRegex = /\b(2|3|4|ii|iii|iv|b|second|third|fourth|challenge|play-offs|cup|super cup|league cup|shield)\b/i;
    if (lowerDivisionRegex.test(name)) return false; 

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


// ==============================================================================
// 🌟🌟 የዘመነ እና የተሟላ የማርኬት ማጣሪያ (Includes Corners, Cards, & Goalscorers) 🌟🌟
// ==============================================================================
const evaluateMarketPick = (pick, match) => {
    const opt = String(pick.odd_name || '').trim();
    const optLower = opt.toLowerCase();
    const marketId = parseInt(pick.market_id, 10) || parseInt(String(pick.odd_id).split('_')[0], 10);
    const marketName = String(pick.market_name || '').toLowerCase();

    const homeName = (match.teams?.home?.name || 'Home').toLowerCase();
    const awayName = (match.teams?.away?.name || 'Away').toLowerCase();

    // 1. የጎል ስሌቶች (Goals)
    const ftHome = match.score?.fulltime?.home ?? match.goals?.home ?? 0;
    const ftAway = match.score?.fulltime?.away ?? match.goals?.away ?? 0;
    const htHome = match.score?.halftime?.home ?? 0;
    const htAway = match.score?.halftime?.away ?? 0;
    
    const ftTotal = ftHome + ftAway;
    const htTotal = htHome + htAway;
    const stHome = ftHome - htHome; 
    const stAway = ftAway - htAway;
    const stTotal = stHome + stAway;

    // 2. የኮርነር እና የካርድ ስሌቶች (ከ API-Football Statistics)
    let homeCorners = 0, awayCorners = 0, homeCards = 0, awayCards = 0;
    const hasStats = match.statistics && match.statistics.length === 2;

    if (hasStats) {
        const getStat = (statsArray, typeName) => {
            const stat = statsArray.find(s => s.type === typeName);
            return stat && stat.value ? parseInt(stat.value, 10) : 0;
        };

        const homeStats = match.statistics[0].statistics || [];
        const awayStats = match.statistics[1].statistics || [];

        homeCorners = getStat(homeStats, 'Corner Kicks');
        awayCorners = getStat(awayStats, 'Corner Kicks');
        
        homeCards = getStat(homeStats, 'Yellow Cards') + getStat(homeStats, 'Red Cards');
        awayCards = getStat(awayStats, 'Yellow Cards') + getStat(awayStats, 'Red Cards');
    }

    const totalCorners = homeCorners + awayCorners;
    const totalCards = homeCards + awayCards;

    // 3. የጎል አግቢዎች ዝርዝር (ከ API-Football Events)
    const goalScorers = [];
    const hasEvents = match.events && match.events.length > 0;
    
    if (hasEvents) {
        match.events.forEach(ev => {
            if (ev.type === 'Goal' && ev.detail !== 'Missed Penalty') {
                goalScorers.push(String(ev.player?.name || '').toLowerCase());
            }
        });
    }

    // የውጤት ሁኔታዎች (Flags)
    const is1 = ftHome > ftAway;
    const isX = ftHome === ftAway;
    const is2 = ftAway > ftHome;
    const isHT1 = htHome > htAway;
    const isHTX = htHome === htAway;
    const isHT2 = htAway > htHome;
    const isST1 = stHome > stAway;
    const isSTX = stHome === stAway;
    const isST2 = stAway > stHome;
    const isGG = ftHome > 0 && ftAway > 0;
    const isNG = !isGG;

    // Over/Under ቁጥሮችን መለየት
    const numMatch = opt.match(/\d+(\.\d+)?/);
    const line = numMatch ? parseFloat(numMatch[0]) : 0;
    const isOver = optLower.includes('over');
    const isUnder = optLower.includes('under');

    // ምርጫዎች ማስተካከያ
    const isOpt1 = opt === '1' || optLower === 'home' || optLower === homeName || optLower === 'w1';
    const isOptX = opt === 'X' || optLower === 'draw' || optLower === 'x';
    const isOpt2 = opt === '2' || optLower === 'away' || optLower === awayName || optLower === 'w2';

    // ---------------------------------------------------------
    // 🚩 1. CORNERS (ኮርነሮች) - [market_id: 85, 295, 79, 88]
    // ---------------------------------------------------------
    if (marketId === 85 || marketId === 295 || marketId === 79 || marketId === 88 || marketName.includes('corner')) {
        if (!hasStats) return 'pending'; // ⚠️ የኮርነር ዳታ ገና ካልመጣ 'pending' ይሆናል እንጂ አያስበላም!

        // Total Corners
        if (marketId === 85 || marketId === 295 || marketName.includes('total')) {
            if (isOver) return totalCorners > line ? 'won' : 'lost';
            if (isUnder) return totalCorners < line ? 'won' : 'lost';
            if (optLower.includes('exact') || !isNaN(opt)) {
                const exactLine = parseInt(opt.replace(/[^0-9]/g, ''), 10);
                return totalCorners === exactLine ? 'won' : 'lost';
            }
        }
        // Corner 1X2
        if (marketId === 79 || marketName.includes('1x2')) {
            if (isOpt1) return homeCorners > awayCorners ? 'won' : 'lost';
            if (isOptX) return homeCorners === awayCorners ? 'won' : 'lost';
            if (isOpt2) return awayCorners > homeCorners ? 'won' : 'lost';
        }
        // Corner Odd/Even
        if (marketId === 88 || marketName.includes('odd/even')) {
            const isCornerEven = totalCorners % 2 === 0;
            if (optLower === 'even') return isCornerEven ? 'won' : 'lost';
            if (optLower === 'odd') return !isCornerEven ? 'won' : 'lost';
        }
    }

    // ---------------------------------------------------------
    // 🟨 CARDS (ካርዶች)
    // ---------------------------------------------------------
    if (marketName.includes('card') || optLower.includes('cards')) {
        if (!hasStats) return 'pending'; 
        if (isOver) return totalCards > line ? 'won' : 'lost';
        if (isUnder) return totalCards < line ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // 🏃‍♂️ ANYTIME GOALSCORER (ጎል አግቢ) - [market_id: 92]
    // ---------------------------------------------------------
    if (marketId === 92 || marketName.includes('goalscorer') || marketName.includes('player to score')) {
        if (!hasEvents) return 'pending'; // ⚠️ የጎል ዳታ ከሌለ ይቆያል
        const hasScored = goalScorers.some(scorer => scorer.includes(optLower) || optLower.includes(scorer));
        // ⚠️ API-Football ላይ ተጫዋቹ ተቀይሮ ካልገባ "Void" መሆን አለበት, አሁን ግን ላለማበላሸት 'lost' እንለዋለን።
        return hasScored ? 'won' : 'lost'; 
    }

    // ---------------------------------------------------------
    // ⚽ MATCH WINNER (1X2) - [market_id: 1, 13]
    // ---------------------------------------------------------
    if (marketId === 1 || marketId === 13 || ['1', 'x', '2', 'draw'].includes(optLower) || isOpt1 || isOptX || isOpt2) {
        if (marketId === 13 || optLower.includes('1st half') || optLower.includes('ht winner')) {
            if (isOpt1) return isHT1 ? 'won' : 'lost';
            if (isOptX) return isHTX ? 'won' : 'lost';
            if (isOpt2) return isHT2 ? 'won' : 'lost';
        } else {
            if (isOpt1) return is1 ? 'won' : 'lost';
            if (isOptX) return isX ? 'won' : 'lost';
            if (isOpt2) return is2 ? 'won' : 'lost';
        }
    }

    // ---------------------------------------------------------
    // ⚽ DOUBLE CHANCE - [market_id: 12]
    // ---------------------------------------------------------
    if (marketId === 12 || marketName.includes('double chance')) {
        if (optLower === '1x' || optLower.includes('home/draw')) return (is1 || isX) ? 'won' : 'lost';
        if (optLower === '12' || optLower.includes('home/away')) return (is1 || is2) ? 'won' : 'lost';
        if (optLower === 'x2' || optLower.includes('draw/away') || optLower.includes('away/draw')) return (is2 || isX) ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ BOTH TEAMS TO SCORE (BTTS) - [market_id: 8, 17]
    // ---------------------------------------------------------
    if (marketId === 8 || marketName.includes('both teams to score')) {
        if (optLower === 'yes' || optLower.includes('gg')) return isGG ? 'won' : 'lost';
        if (optLower === 'no' || optLower.includes('ng')) return isNG ? 'won' : 'lost';
    }
    if (marketId === 17) { 
        const isHfGG = htHome > 0 && htAway > 0;
        if (optLower === 'yes' || optLower.includes('gg')) return isHfGG ? 'won' : 'lost';
        if (optLower === 'no' || optLower.includes('ng')) return !isHfGG ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ TOTAL GOALS (OVER / UNDER) - [market_id: 5, 6, 16, 17]
    // ---------------------------------------------------------
    if (marketId === 5 || marketId === 6 || marketId === 16 || marketId === 17 || marketName.includes('total goals') || marketName.includes('over/under')) {
        let targetTotal = ftTotal;
        if (marketId === 6 || marketName.includes('1st half') || optLower.includes('ht over') || optLower.includes('ht under')) targetTotal = htTotal;
        if (marketId === 16 || marketName.includes('home')) targetTotal = ftHome;
        if (marketId === 17 || marketName.includes('away')) targetTotal = ftAway;

        if (isOver) return targetTotal > line ? 'won' : 'lost';
        if (isUnder) return targetTotal < line ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ CORRECT SCORE & EXACT GOALS - [market_id: 10, 31, 38, 349]
    // ---------------------------------------------------------
    if (marketId === 10 || marketId === 31 || marketName.includes('correct score')) {
        const cleanOpt = opt.replace(':', '-').trim();
        const actualScore = `${ftHome}-${ftAway}`;
        return cleanOpt === actualScore ? 'won' : 'lost';
    }
    if (marketId === 38 || marketName.includes('exact goals')) {
        return ftTotal === line ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ ODD / EVEN - [market_id: 21]
    // ---------------------------------------------------------
    if (marketId === 21 || marketName.includes('odd/even')) {
        const isEven = ftTotal % 2 === 0;
        if (optLower === 'even') return isEven ? 'won' : 'lost';
        if (optLower === 'odd') return !isEven ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ DRAW NO BET (DNB) - [market_id: 2]
    // ---------------------------------------------------------
    if (marketId === 2 || marketName.includes('draw no bet')) {
        if (isX) return 'void'; // አቻ ከሆነ ገንዘብ ይመለሳል (Refund)
        if (isOpt1) return is1 ? 'won' : 'lost';
        if (isOpt2) return is2 ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ HALFTIME / FULLTIME (HT/FT) - [market_id: 7]
    // ---------------------------------------------------------
    if (marketId === 7 || marketName.includes('halftime/fulltime') || opt.includes('/')) {
        let htRes = isHT1 ? '1' : isHTX ? 'x' : '2';
        let ftRes = is1 ? '1' : isX ? 'x' : '2';
        
        let expectedHT = opt.split('/')[0].trim().toLowerCase();
        let expectedFT = opt.split('/')[1].trim().toLowerCase();
        
        const mapRes = (val) => {
            if (val === 'home' || val === homeName || val === 'w1') return '1';
            if (val === 'away' || val === awayName || val === 'w2') return '2';
            if (val === 'draw') return 'x';
            return val;
        };

        return (htRes === mapRes(expectedHT) && ftRes === mapRes(expectedFT)) ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ HIGHEST SCORING HALF - [market_id: 11]
    // ---------------------------------------------------------
    if (marketId === 11 || marketName.includes('highest scoring half')) {
        if (optLower.includes('1st') || optLower.includes('first')) return htTotal > stTotal ? 'won' : 'lost';
        if (optLower.includes('2nd') || optLower.includes('second')) return stTotal > htTotal ? 'won' : 'lost';
        if (optLower.includes('draw') || optLower.includes('equal')) return htTotal === stTotal ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ 1X2 & BTTS - [market_id: 24]
    // ---------------------------------------------------------
    if (marketId === 24 || marketName.includes('1x2 & both teams to score')) {
        const expectsYes = optLower.includes('yes');
        const expectsNo = optLower.includes('no');
        const bttsPass = (expectsYes && isGG) || (expectsNo && isNG);
        
        let resPass = false;
        if (optLower.includes('home') || optLower.startsWith('1')) resPass = is1;
        else if (optLower.includes('draw') || optLower.startsWith('x')) resPass = isX;
        else if (optLower.includes('away') || optLower.startsWith('2')) resPass = is2;

        return (bttsPass && resPass) ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ 1X2 & TOTAL GOALS - [market_id: 25]
    // ---------------------------------------------------------
    if (marketId === 25 || marketName.includes('1x2 & total')) {
        const totalPass = (isOver && ftTotal > line) || (isUnder && ftTotal < line);
        let resPass = false;
        if (optLower.includes('home') || optLower.startsWith('1')) resPass = is1;
        else if (optLower.includes('draw') || optLower.startsWith('x')) resPass = isX;
        else if (optLower.includes('away') || optLower.startsWith('2')) resPass = is2;

        return (totalPass && resPass) ? 'won' : 'lost';
    }

    // ---------------------------------------------------------
    // ⚽ DOUBLE CHANCE & BTTS - [market_id: 33]
    // ---------------------------------------------------------
    if (marketId === 33 || marketName.includes('double chance & both teams to score')) {
        const expectsYes = optLower.includes('yes');
        const expectsNo = optLower.includes('no');
        const bttsPass = (expectsYes && isGG) || (expectsNo && isNG);

        let dcPass = false;
        if (optLower.includes('1x') || optLower.includes('home/draw')) dcPass = (is1 || isX);
        else if (optLower.includes('12') || optLower.includes('home/away')) dcPass = (is1 || is2);
        else if (optLower.includes('x2') || optLower.includes('draw/away')) dcPass = (is2 || isX);

        return (bttsPass && dcPass) ? 'won' : 'lost';
    }

    // ያልታወቀ ማርኬት ከሆነ በደህንነት ፔንዲንግ ያደርገዋል
    return 'pending'; 
};
// ==============================================================================

const runAutoSettlement = async () => {
    try {
        const [pendingItems] = await db.query(`SELECT id, fixture_id, odd_name, odd_id, market_id, market_name FROM ticket_items WHERE match_status = 'pending'`);
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
                            await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", ['void', 'Postponed', pick.id]);
                        }
                        continue;
                    }

                    if (isCompleted) {
                        const ftHome = match.score?.fulltime?.home ?? match.goals?.home ?? 0;
                        const ftAway = match.score?.fulltime?.away ?? match.goals?.away ?? 0;
                        const scoreStr = `${ftHome}-${ftAway}`;

                        for (let pick of associatedPicks) {
                            const resultStatus = evaluateMarketPick(pick, match);

                            if (resultStatus !== 'pending') {
                                await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", [resultStatus, scoreStr, pick.id]);
                            }
                        }
                    }
                }
            } catch (err) { }
        }

        await db.query(`UPDATE tickets t SET status = 'lost' WHERE status IN ('active', 'pending') AND EXISTS (SELECT 1 FROM ticket_items ti WHERE ti.ticket_id = t.id AND ti.match_status = 'lost')`);
        await db.query(`UPDATE tickets t SET status = 'won' WHERE status IN ('active', 'pending') AND NOT EXISTS (SELECT 1 FROM ticket_items ti WHERE ti.ticket_id = t.id AND ti.match_status IN ('pending', 'lost')) AND EXISTS (SELECT 1 FROM ticket_items ti WHERE ti.ticket_id = t.id AND ti.match_status IN ('won', 'postponed', 'void'))`);

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