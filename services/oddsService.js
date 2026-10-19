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
        // የ score ኮለምን እንደ "ኮርነር 9:4 (13)" ወይም "1H 0:1 / FT 1:3" ያሉ ውጤቶችን እንዲይዝ ማስፋት
        try { await db.query(`ALTER TABLE ticket_items MODIFY score VARCHAR(64) DEFAULT NULL`); } catch (e) {}
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

const rotateExhaustedKeyToEnd = async (exhaustedKey, permanentDelete = false) => {
    try {
        let keys = await getApiKeysArray();
        if (permanentDelete) {
            keys = keys.filter(k => k !== exhaustedKey);
            console.log(`\n🗑️ የተሳሳተ API Key ተሰርዟል!`);
        } else if (keys.length > 1) {
            keys = [...keys.filter(k => k !== exhaustedKey), exhaustedKey];
            console.log(`\n🔄 የዛሬ ኮታው ያለቀው API Key ለነገ እንዲያገለግል ወደ ተራው መጨረሻ ተዘዋውሯል!`);
        }
        await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'api_football_key'", [keys.join(',')]);
    } catch (e) {}
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const createApiClient = (initialKeys, baseUrl) => {
    let apiKeys = [...initialKeys];
    let currentKey = apiKeys[0];
    let headers = { 'x-apisports-key': currentKey };
    let requestsRemaining = Infinity;

    const rotate = async (reason = '', isInvalidKey = false) => {
        if (reason) console.log(`\n⚠️ API-Football Key ችግር (${reason}) — ወደሚቀጥለው Key በመቀየር ላይ...`);
        await rotateExhaustedKeyToEnd(currentKey, isInvalidKey);
        apiKeys = apiKeys.filter(k => k !== currentKey);
        if (apiKeys.length === 0) return false;
        currentKey = apiKeys[0];
        headers = { 'x-apisports-key': currentKey };
        requestsRemaining = Infinity;
        return true;
    };

    const trackUsage = async (respHeaders) => {
        if (!respHeaders || respHeaders['x-ratelimit-requests-remaining'] === undefined) return;
        const remaining = parseInt(respHeaders['x-ratelimit-requests-remaining'], 10);
        const limit = parseInt(respHeaders['x-ratelimit-requests-limit'], 10);
        if (!Number.isNaN(remaining)) requestsRemaining = remaining;
        try {
            const used = !Number.isNaN(limit) && !Number.isNaN(remaining) ? (limit - remaining) : 0;
            await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_used', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [used, used]);
            await db.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('api_remaining', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [remaining, remaining]);
        } catch (e) {}
    };

    const get = async (path, params) => {
        while (true) {
            if (requestsRemaining <= 1 && apiKeys.length > 1) {
                const rotated = await rotate('Daily quota reached (remaining <= 1)');
                if (!rotated) break;
            }
            try {
                const resp = await axios.get(`${baseUrl}${path}`, { headers, params, timeout: 12000 });
                await trackUsage(resp.headers);

                // API-Football 200 OK መልሶ በውስጡ errors ካለው ማጣራት
                const apiErrors = resp.data && resp.data.errors;
                if (apiErrors && typeof apiErrors === 'object' && Object.keys(apiErrors).length > 0) {
                    const errMsg = Object.values(apiErrors).join(' | ');
                    const isInvalidToken = Boolean(apiErrors.token || errMsg.toLowerCase().includes('application key'));
                    if (isInvalidToken || apiErrors.requests || apiErrors.access || errMsg.toLowerCase().includes('limit') || errMsg.toLowerCase().includes('key')) {
                        const rotated = await rotate(errMsg, isInvalidToken);
                        if (!rotated) {
                            console.error(`❌ ሁሉም API-Football Keys የዛሬ ኮታቸው አልቋል ወይም ትክክል አይደሉም: ${errMsg}`);
                            return resp;
                        }
                        continue;
                    }
                    console.warn(`⚠️ API-Football ማስጠንቀቂያ (${path}): ${errMsg}`);
                }

                return resp;
            } catch (err) {
                const status = err.response && err.response.status;
                if (status === 429 || status === 403 || status === 401) {
                    const rotated = await rotate(`HTTP ${status} on ${path}`, status === 401);
                    if (!rotated) throw err; 
                    continue; 
                }
                throw err; 
            }
        }
    };

    return { get, rotate, remaining: () => requestsRemaining, hasKeys: () => apiKeys.length > 0 };
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
        return false;
    }
};

let isFetchingMatches = false;
const fetchAndSaveMatches = async () => {
    if (isFetchingMatches) return false;
    isFetchingMatches = true;
    try {
        console.log(`\n⏳ ከ API-Football ጥርት ያሉ ጨዋታዎችን በማምጣት ላይ...`);
        let totalWithOdds = 0;

        const apiKeys = await getApiKeysArray();
        if (apiKeys.length === 0) return false;

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
            if (!client.hasKeys()) break;
            if (client.remaining() <= 2) {
                const rotated = await client.rotate('Quota low before next date');
                if (!rotated) break;
            }

            try {
                const fixResp = await client.get('/fixtures', { date: dateStr });
                const apiErrs = fixResp?.data?.errors;
                if (apiErrs && apiErrs.plan) {
                    console.log(`ℹ️ የ API Plan ገደብ (${dateStr}): ${apiErrs.plan}`);
                    break;
                }

                const allFixtures = fixResp?.data?.response || [];
                const validFixtures = allFixtures.filter(fix => isLeagueAllowed(fix.league, dayOffset));
                if (validFixtures.length === 0) continue;

                const fixturesMap = new Map(validFixtures.map(f => [f.fixture.id, f]));
                const oddsMap = new Map();
                const targetBookies = [8, 11, 17];
                
                for (const bookieId of targetBookies) {
                    if (oddsMap.size >= validFixtures.length) break; 
                    let page = 1, totalPages = 1;
                    while (page <= totalPages) {
                        if (client.remaining() <= 2) {
                            const rotated = await client.rotate('Quota low during odds pagination');
                            if (!rotated) break;
                        }
                        try {
                            const oddsResp = await client.get('/odds', { date: dateStr, page, bookmaker: bookieId });
                            if (oddsResp?.data?.errors?.plan) break;
                            (oddsResp?.data?.response || []).forEach(odd => {
                                if (fixturesMap.has(odd.fixture.id) && !oddsMap.has(odd.fixture.id) && odd.bookmakers?.length > 0) {
                                    oddsMap.set(odd.fixture.id, odd.bookmakers[0]);
                                }
                            });
                            totalPages = oddsResp?.data?.paging?.total || 1;
                            page++;
                            await delay(250);
                        } catch (e) { page++; await delay(800); }
                    }
                }

                const missingTopFixtures = validFixtures.filter(f => topLeagueIds.includes(f.league.id)).filter(f => !oddsMap.has(f.fixture.id));
                for (const missingFix of missingTopFixtures) {
                    if (client.remaining() <= 2) {
                        const rotated = await client.rotate('Quota low during top fixtures odds');
                        if (!rotated) break;
                    }
                    try {
                        const oddsResp = await client.get('/odds', { fixture: missingFix.fixture.id });
                        const oddData = oddsResp?.data?.response?.[0];
                        if (oddData && oddData.bookmakers?.length > 0) {
                            const bestBm = oddData.bookmakers.find(b => b.id === 8) || oddData.bookmakers.find(b => b.id === 11) || oddData.bookmakers[0];
                            oddsMap.set(missingFix.fixture.id, bestBm);
                        }
                        await delay(300);
                    } catch (e) { await delay(800); }
                }

                for (const [fixtureId, bookmakerData] of oddsMap.entries()) {
                    const fix = fixturesMap.get(fixtureId);
                    if (!fix) continue;
                    const sportKey = getStandardSportKey(fix.league);
                    const ok = await upsertMatch(fix, sportKey, bookmakerData);
                    if (ok) { totalWithOdds++; }
                }

            } catch (err) {
                console.error(`Error syncing date ${dateStr}:`, err.message);
            }
        }

        console.log(`\n🎉 በአጠቃላይ ${totalWithOdds} ጨዋታዎች ተመዝግበዋል!`);
        return true;
    } catch (error) {
        return false;
    } finally {
        isFetchingMatches = false;
    }
};

// ==============================================================================
// 🌟🌟 ሙሉ እና አውቶማቲክ የማርኬት ማጣሪያ (100% Comprehensive Auto-Evaluator) 🌟🌟
// ==============================================================================

const stripAccents = (str) =>
    String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ø/gi, 'o')
        .replace(/æ/gi, 'ae')
        .replace(/ß/g, 'ss');

const STOP_TEAM_TOKENS = new Set([
    'w', 'women', 'fem', 'female', 'ladies', 'fc', 'cf', 'sc', 'fk', 'sk', 'bk', 'ik',
    'gik', 'dff', 'ff', 'if', 'afc', 'ac', 'as', 'sv', 'tsv', 'vfb', 'vfl', 'bsc',
    'ud', 'cd', 'sd', 'rcd', 'ca', 'cs', 'ks', 'nk', 'hnk', 'pfk', 'pfc', 'ofk',
    'u17', 'u18', 'u19', 'u20', 'u21', 'u23', 'ii', '2', 'b', 'club', 'team', 'de', 'al'
]);

const getCleanTeamWords = (name) => {
    const clean = stripAccents(name)
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ');
    const words = clean.split(/\s+/).filter(w => w.length > 1 && !STOP_TEAM_TOKENS.has(w));
    return words.length > 0 ? words : clean.split(/\s+/).filter(Boolean);
};

const teamsMatch = (nameA, nameB) => {
    if (!nameA || !nameB) return false;
    const normA = stripAccents(nameA).toLowerCase().replace(/[^a-z0-9]/g, '');
    const normB = stripAccents(nameB).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normA || !normB) return false;
    if (normA === normB || normA.includes(normB) || normB.includes(normA)) return true;

    const wordsA = getCleanTeamWords(nameA);
    const wordsB = getCleanTeamWords(nameB);
    const coreA = wordsA.join('');
    const coreB = wordsB.join('');
    if (coreA && coreB && (coreA === coreB || coreA.includes(coreB) || coreB.includes(coreA))) return true;

    for (const wa of wordsA) {
        if (wa.length < 4) continue;
        const stemA = wa.endsWith('s') && wa.length > 5 ? wa.slice(0, -1) : wa;
        for (const wb of wordsB) {
            if (wb.length < 4) continue;
            const stemB = wb.endsWith('s') && wb.length > 5 ? wb.slice(0, -1) : wb;
            if (stemA === stemB || (stemA.length >= 5 && stemB.includes(stemA)) || (stemB.length >= 5 && stemA.includes(stemB))) {
                return true;
            }
        }
    }
    return false;
};

const SOFASCORE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.sofascore.com',
    'Referer': 'https://www.sofascore.com/'
};

const extractSofaPeriodCorners = (statisticsArray, periodName) => {
    if (!Array.isArray(statisticsArray)) return null;
    const periodObj = statisticsArray.find(p => String(p.period || '').toUpperCase() === periodName.toUpperCase());
    if (!periodObj || !Array.isArray(periodObj.groups)) return null;
    for (const grp of periodObj.groups) {
        for (const item of (grp.statisticsItems || [])) {
            const key = String(item.key || '').toLowerCase();
            const name = String(item.name || '').toLowerCase();
            if (key === 'cornerkicks' || name.includes('corner')) {
                const hVal = item.homeValue !== undefined ? Number(item.homeValue) : parseFloat(item.home);
                const aVal = item.awayValue !== undefined ? Number(item.awayValue) : parseFloat(item.away);
                if (Number.isFinite(hVal) && Number.isFinite(aVal)) {
                    return { h: hVal, a: aVal };
                }
            }
        }
    }
    return null;
};

const fetchSofaHalfCorners = async (homeTeam, awayTeam) => {
    if (!homeTeam || !awayTeam) return null;
    try {
        const cleanH = getCleanTeamWords(homeTeam).join(' ') || homeTeam;
        const cleanA = getCleanTeamWords(awayTeam).join(' ') || awayTeam;
        const sRes = await axios.get(
            `https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(`${cleanH} ${cleanA}`)}`,
            { headers: SOFASCORE_HEADERS, timeout: 4500 }
        ).catch(() => null);

        const results = sRes?.data?.results || [];
        let targetEv = null;
        for (const r of results) {
            if (r.type === 'event' && r.entity) {
                const hName = r.entity.homeTeam?.name || r.entity.homeTeam?.shortName || '';
                const aName = r.entity.awayTeam?.name || r.entity.awayTeam?.shortName || '';
                if (teamsMatch(homeTeam, hName) && teamsMatch(awayTeam, aName)) {
                    targetEv = r.entity;
                    break;
                }
            }
        }
        if (!targetEv) return null;

        const statsRes = await axios.get(
            `https://api.sofascore.com/api/v1/event/${targetEv.id}/statistics`,
            { headers: SOFASCORE_HEADERS, timeout: 4500 }
        ).catch(() => null);

        const statsArr = statsRes?.data?.statistics || [];
        return {
            all: extractSofaPeriodCorners(statsArr, 'ALL'),
            firstHalf: extractSofaPeriodCorners(statsArr, '1ST'),
            secondHalf: extractSofaPeriodCorners(statsArr, '2ND')
        };
    } catch (e) {
        return null;
    }
};

// 🌟 የድሮ (Legacy Non-Numeric IDs) ጨዋታዎችን ከ SofaScore በቡድን ስም በማምጣት ወደ API-Football ፎርማት የሚቀይር ረዳት ፈንክሽን 🌟
const fetchFallbackMatchFromSofaByNames = async (homeTeam, awayTeam) => {
    if (!homeTeam || !awayTeam) return null;
    try {
        const cleanH = getCleanTeamWords(homeTeam).join(' ') || homeTeam;
        const cleanA = getCleanTeamWords(awayTeam).join(' ') || awayTeam;
        const sRes = await axios.get(
            `https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(`${cleanH} ${cleanA}`)}`,
            { headers: SOFASCORE_HEADERS, timeout: 4500 }
        ).catch(() => null);

        const results = sRes?.data?.results || [];
        let matchedEv = null;
        for (const r of results) {
            if (r.type === 'event' && r.entity) {
                const hName = r.entity.homeTeam?.name || r.entity.homeTeam?.shortName || '';
                const aName = r.entity.awayTeam?.name || r.entity.awayTeam?.shortName || '';
                if (teamsMatch(homeTeam, hName) && teamsMatch(awayTeam, aName)) {
                    matchedEv = r.entity;
                    if (String(r.entity.status?.type || '').toLowerCase() === 'finished') break;
                }
            }
        }
        if (!matchedEv) return null;

        const [eventRes, statsRes, incRes] = await Promise.all([
            axios.get(`https://api.sofascore.com/api/v1/event/${matchedEv.id}`, { headers: SOFASCORE_HEADERS, timeout: 4500 }).catch(() => null),
            axios.get(`https://api.sofascore.com/api/v1/event/${matchedEv.id}/statistics`, { headers: SOFASCORE_HEADERS, timeout: 4500 }).catch(() => null),
            axios.get(`https://api.sofascore.com/api/v1/event/${matchedEv.id}/incidents`, { headers: SOFASCORE_HEADERS, timeout: 4500 }).catch(() => null)
        ]);

        const fullEv = eventRes?.data?.event || matchedEv;
        const statusType = String(fullEv.status?.type || '').toLowerCase();
        const isCompleted = statusType === 'finished';
        const isCancelled = ['canceled', 'cancelled', 'postponed', 'abandoned'].includes(statusType);

        const hScoreObj = fullEv.homeScore || {};
        const aScoreObj = fullEv.awayScore || {};
        const htHome = hScoreObj.period1 !== undefined && hScoreObj.period1 !== null ? Number(hScoreObj.period1) : null;
        const htAway = aScoreObj.period1 !== undefined && aScoreObj.period1 !== null ? Number(aScoreObj.period1) : null;

        let ftHome = hScoreObj.normaltime !== undefined && hScoreObj.normaltime !== null
            ? Number(hScoreObj.normaltime)
            : Number(hScoreObj.current ?? 0);
        let ftAway = aScoreObj.normaltime !== undefined && aScoreObj.normaltime !== null
            ? Number(aScoreObj.normaltime)
            : Number(aScoreObj.current ?? 0);

        if (htHome !== null && htAway !== null && hScoreObj.period2 !== undefined && aScoreObj.period2 !== undefined) {
            ftHome = htHome + Number(hScoreObj.period2);
            ftAway = htAway + Number(aScoreObj.period2);
        }

        const statsArr = statsRes?.data?.statistics || [];
        const allCorners = extractSofaPeriodCorners(statsArr, 'ALL');
        const firstHalfCorners = extractSofaPeriodCorners(statsArr, '1ST');
        const secondHalfCorners = extractSofaPeriodCorners(statsArr, '2ND');

        const events = [];
        for (const inc of (incRes?.data?.incidents || [])) {
            if (inc.incidentType === 'goal' && inc.incidentClass !== 'missedPenalty') {
                const elapsed = Number(inc.time ?? 90);
                if (elapsed <= 90) {
                    events.push({
                        type: 'Goal',
                        detail: 'Normal Goal',
                        team: { id: inc.isHome ? 1 : 2 },
                        player: { name: inc.player?.name || inc.player?.shortName || '' },
                        time: { elapsed }
                    });
                }
            }
        }

        const syntheticMatch = {
            fixture: {
                id: fullEv.id,
                status: { short: isCancelled ? 'PST' : isCompleted ? 'FT' : 'LIVE' }
            },
            teams: {
                home: { id: 1, name: fullEv.homeTeam?.name || homeTeam },
                away: { id: 2, name: fullEv.awayTeam?.name || awayTeam }
            },
            goals: { home: ftHome, away: ftAway },
            score: {
                halftime: { home: htHome, away: htAway },
                fulltime: { home: ftHome, away: ftAway }
            },
            statistics: allCorners ? [
                { team: { id: 1 }, statistics: [{ type: 'Corner Kicks', value: allCorners.h }] },
                { team: { id: 2 }, statistics: [{ type: 'Corner Kicks', value: allCorners.a }] }
            ] : [],
            events
        };

        return {
            match: syntheticMatch,
            extraCornerData: {
                all: allCorners,
                firstHalf: firstHalfCorners,
                secondHalf: secondHalfCorners
            }
        };
    } catch (e) {
        return null;
    }
};

const evalOUPickValue = (optStr, targetVal) => {
    const p = String(optStr || '').trim();
    const m = p.match(/(?:^|[\s\/(\-])(over|under|o|u|\+|\-)\s*\/?\s*\(?([\d.]+)\)?/i);
    if (!m) return null;
    const dir = m[1].toLowerCase();
    const line = parseFloat(m[2]);
    if (dir === 'over' || dir === 'o' || dir === '+') return targetVal > line;
    if (dir === 'under' || dir === 'u' || dir === '-') return targetVal < line;
    return null;
};

const evalRangeOrExactValue = (optStr, targetVal) => {
    const p = String(optStr || '').trim().toLowerCase();
    if (['no goal', 'none', '0', 'no goals', 'no corner', 'no corners'].includes(p)) {
        return targetVal === 0;
    }
    const rangeMatch = p.match(/(\d+)\s*[\-–to]+\s*(\d+)/);
    if (rangeMatch) {
        const low = parseInt(rangeMatch[1], 10);
        const high = parseInt(rangeMatch[2], 10);
        return targetVal >= low && targetVal <= high;
    }
    const plusMatch = p.match(/(\d+)\s*\+/);
    if (plusMatch) {
        return targetVal >= parseInt(plusMatch[1], 10);
    }
    const exactMatch = p.match(/^(?:exact\s*)?(\d+)(?:\s*goals?|\s*corners?)?$/);
    if (exactMatch) {
        return targetVal === parseInt(exactMatch[1], 10);
    }
    return evalOUPickValue(optStr, targetVal);
};

// ውጤቱን (won/lost/void/pending) እና በትኬቱ ላይ መታየት ያለበትን ትክክለኛ ውጤት (displayScore) አንድ ላይ የሚመልስ
const evaluateMarketPickWithScore = (pick, match, extraCornerData = null) => {
    const opt = String(pick.odd_name || '').trim();
    const optLower = opt.toLowerCase();
    const marketId = parseInt(pick.market_id, 10) || parseInt(String(pick.odd_id).split('_')[0], 10) || 0;
    const marketName = String(pick.market_name || '').toLowerCase();
    const marketKey = String(pick.market_key || '').toLowerCase();
    const mCombined = `${marketName} ${marketKey}`.trim();

    const homeName = (match.teams?.home?.name || 'Home').toLowerCase();
    const awayName = (match.teams?.away?.name || 'Away').toLowerCase();

    // --- Goals Calculation (90 ደቂቃ ብቻ) ---
    const ftHome = Number(match.score?.fulltime?.home ?? match.goals?.home ?? 0);
    const ftAway = Number(match.score?.fulltime?.away ?? match.goals?.away ?? 0);
    const hasHT = match.score?.halftime?.home !== null && match.score?.halftime?.home !== undefined &&
                  match.score?.halftime?.away !== null && match.score?.halftime?.away !== undefined;
    const htHome = hasHT ? Number(match.score.halftime.home) : (ftHome === 0 && ftAway === 0 ? 0 : null);
    const htAway = hasHT ? Number(match.score.halftime.away) : (ftHome === 0 && ftAway === 0 ? 0 : null);

    const ftTotal = ftHome + ftAway;
    const htTotal = (htHome !== null && htAway !== null) ? (htHome + htAway) : null;
    const stHome = htHome !== null ? Math.max(0, ftHome - htHome) : null;
    const stAway = htAway !== null ? Math.max(0, ftAway - htAway) : null;
    const stTotal = (stHome !== null && stAway !== null) ? (stHome + stAway) : null;

    const defaultScoreStr = `${ftHome}:${ftAway}`;

    const getPeriodGoals = (name) => {
        if (name.includes('1st half') || name.includes('first half')) {
            if (htHome === null || htAway === null) return null;
            return { home: htHome, away: htAway, label: `1H ${htHome}:${htAway} (FT ${defaultScoreStr})` };
        }
        if (name.includes('2nd half') || name.includes('second half')) {
            if (stHome === null || stAway === null) return null;
            return { home: stHome, away: stAway, label: `2H ${stHome}:${stAway} (FT ${defaultScoreStr})` };
        }
        return { home: ftHome, away: ftAway, label: defaultScoreStr };
    };

    // --- Statistics (Corners, Cards) በ team.id በትክክል መለየት ---
    let homeCorners = null, awayCorners = null, homeCards = null, awayCards = null, homeRed = null, awayRed = null;
    const statsList = Array.isArray(match.statistics) ? match.statistics : [];

    if (statsList.length >= 2) {
        const homeStatObj = statsList.find(s => s.team?.id === match.teams?.home?.id) || statsList[0];
        const awayStatObj = statsList.find(s => s.team?.id === match.teams?.away?.id) || statsList[1];
        const homeStats = homeStatObj?.statistics || [];
        const awayStats = awayStatObj?.statistics || [];

        const getStatNullable = (statsArray, typeNames) => {
            for (const s of statsArray) {
                const t = String(s.type || s.name || '').toLowerCase();
                if (typeNames.some(n => t === n || t.includes(n))) {
                    if (s.value === null || s.value === undefined) return 0;
                    const parsed = parseInt(s.value, 10);
                    return Number.isFinite(parsed) ? parsed : 0;
                }
            }
            return null;
        };

        homeCorners = getStatNullable(homeStats, ['corner kicks', 'corners']);
        awayCorners = getStatNullable(awayStats, ['corner kicks', 'corners']);
        homeRed = getStatNullable(homeStats, ['red cards']) ?? 0;
        awayRed = getStatNullable(awayStats, ['red cards']) ?? 0;
        const homeYellow = getStatNullable(homeStats, ['yellow cards']) ?? 0;
        const awayYellow = getStatNullable(awayStats, ['yellow cards']) ?? 0;
        homeCards = homeYellow + homeRed;
        awayCards = awayYellow + awayRed;
    }

    if ((homeCorners === null || awayCorners === null) && extraCornerData?.all) {
        homeCorners = extraCornerData.all.h;
        awayCorners = extraCornerData.all.a;
    }

    // --- Events (Goalscorers, First/Last Goal, 10 Minutes) - 90 ደቂቃ ብቻ ---
    const goalEvents = [];
    const hasEvents = Array.isArray(match.events) && match.events.length > 0;
    if (hasEvents) {
        match.events.forEach(ev => {
            const elapsed = Number(ev.time?.elapsed ?? 0);
            if (ev.type === 'Goal' && ev.detail !== 'Missed Penalty' && elapsed <= 90 && ev.comments !== 'Penalty Shootout') {
                goalEvents.push({
                    team: ev.team?.id === match.teams?.home?.id ? 'home' : 'away',
                    player: String(ev.player?.name || '').toLowerCase(),
                    time: elapsed
                });
            }
        });
        goalEvents.sort((a, b) => a.time - b.time);
    }

    const is1 = ftHome > ftAway;
    const isX = ftHome === ftAway;
    const is2 = ftAway > ftHome;
    const isGG = ftHome > 0 && ftAway > 0;
    const isNG = !isGG;

    const numMatch = opt.match(/[-+]?\d+(\.\d+)?/);
    const line = numMatch ? parseFloat(numMatch[0]) : 0;

    const isOpt1 = opt === '1' || optLower === 'home' || optLower === homeName || optLower === 'w1' || teamsMatch(opt, homeName);
    const isOptX = opt === 'X' || optLower === 'draw' || optLower === 'x' || optLower === 'tie';
    const isOpt2 = opt === '2' || optLower === 'away' || optLower === awayName || optLower === 'w2' || teamsMatch(opt, awayName);

    // =========================================================================
    // 🚦 1. CORNERS (ሁሉም የኮርነር ማርኬቶች፦ FT, 1st Half, 2nd Half, Home, Away, 1X2, Odd/Even, Range)
    // =========================================================================
    const isCornerMarket =
        [85, 79, 295, 88, 86, 87, 89, 90].includes(marketId) ||
        mCombined.includes('corner') ||
        optLower.includes('corner');

    if (isCornerMarket) {
        const is1stHalfCorner = mCombined.includes('1st half') || mCombined.includes('first half') || optLower.includes('1st half');
        const is2ndHalfCorner = mCombined.includes('2nd half') || mCombined.includes('second half') || optLower.includes('2nd half');
        const isHomeCorner = marketId === 89 || mCombined.includes('home total corners') || mCombined.includes('home corners') || mCombined.includes('corners - home');
        const isAwayCorner = marketId === 90 || mCombined.includes('away total corners') || mCombined.includes('away corners') || mCombined.includes('corners - away');

        if (is1stHalfCorner || is2ndHalfCorner) {
            const halfObj = is1stHalfCorner ? extraCornerData?.firstHalf : extraCornerData?.secondHalf;
            const shortHalf = is1stHalfCorner ? '1H' : '2H';
            if (halfObj && Number.isFinite(halfObj.h) && Number.isFinite(halfObj.a)) {
                const cH = halfObj.h;
                const cA = halfObj.a;
                const cTot = cH + cA;
                const cScore = `${shortHalf} ኮርነር ${cH}:${cA} (${cTot})`;
                let won = null;
                if (isHomeCorner) won = evalRangeOrExactValue(opt, cH);
                else if (isAwayCorner) won = evalRangeOrExactValue(opt, cA);
                else if (mCombined.includes('1x2') || mCombined.includes('most') || mCombined.includes('winner')) {
                    if (isOpt1) won = cH > cA;
                    else if (isOptX) won = cH === cA;
                    else if (isOpt2) won = cA > cH;
                } else if (mCombined.includes('odd/even')) {
                    if (optLower.includes('even')) won = cTot % 2 === 0;
                    else if (optLower.includes('odd')) won = cTot % 2 === 1;
                } else {
                    won = evalRangeOrExactValue(opt, cTot);
                }
                if (won !== null) return { status: won ? 'won' : 'lost', score: cScore };
            }

            if (homeCorners !== null && awayCorners !== null) {
                const ftTarget = isHomeCorner ? homeCorners : isAwayCorner ? awayCorners : (homeCorners + awayCorners);
                const ouMatch = opt.match(/(?:^|[\s\/(\-])(over|under|o|u|\+|\-)\s*\/?\s*\(?([\d.]+)\)?/i);
                if (ouMatch) {
                    const d = ouMatch[1].toLowerCase();
                    const l = parseFloat(ouMatch[2]);
                    if ((d === 'over' || d === 'o' || d === '+') && ftTarget <= l) {
                        return { status: 'lost', score: `FT ኮርነር ${homeCorners}:${awayCorners}` };
                    }
                    if ((d === 'under' || d === 'u' || d === '-') && ftTarget < l) {
                        return { status: 'won', score: `FT ኮርነር ${homeCorners}:${awayCorners}` };
                    }
                }
            }
            return { status: 'pending', score: null };
        }

        if (homeCorners === null || awayCorners === null) {
            return { status: 'pending', score: null };
        }

        const totalCorners = homeCorners + awayCorners;
        const cornerScoreStr = `ኮርነር ${homeCorners}:${awayCorners} (${totalCorners})`;

        if (marketId === 79 || mCombined.includes('1x2') || mCombined.includes('most corners')) {
            if (isOpt1) return { status: homeCorners > awayCorners ? 'won' : 'lost', score: cornerScoreStr };
            if (isOptX) return { status: homeCorners === awayCorners ? 'won' : 'lost', score: cornerScoreStr };
            if (isOpt2) return { status: awayCorners > homeCorners ? 'won' : 'lost', score: cornerScoreStr };
        }
        if (marketId === 88 || mCombined.includes('odd/even')) {
            const isCornerEven = totalCorners % 2 === 0;
            if (optLower.includes('even')) return { status: isCornerEven ? 'won' : 'lost', score: cornerScoreStr };
            if (optLower.includes('odd')) return { status: !isCornerEven ? 'won' : 'lost', score: cornerScoreStr };
        }
        if (isHomeCorner) {
            const won = evalRangeOrExactValue(opt, homeCorners);
            if (won !== null) return { status: won ? 'won' : 'lost', score: cornerScoreStr };
        }
        if (isAwayCorner) {
            const won = evalRangeOrExactValue(opt, awayCorners);
            if (won !== null) return { status: won ? 'won' : 'lost', score: cornerScoreStr };
        }

        const won = evalRangeOrExactValue(opt, totalCorners);
        if (won !== null) return { status: won ? 'won' : 'lost', score: cornerScoreStr };

        return { status: 'pending', score: cornerScoreStr };
    }

    // =========================================================================
    // 🟨🟥 2. CARDS & SENDING OFF (ካርድ እና ቀይ ካርድ)
    // =========================================================================
    if (marketId === 83 || mCombined.includes('sending off')) {
        if (homeRed === null || awayRed === null) return { status: 'pending', score: null };
        const totalRedCards = homeRed + awayRed;
        if (optLower.includes('yes') || optLower === 'gg') return { status: totalRedCards > 0 ? 'won' : 'lost', score: `ቀይ ካርድ: ${totalRedCards}` };
        if (optLower.includes('no') || optLower === 'ng') return { status: totalRedCards === 0 ? 'won' : 'lost', score: `ቀይ ካርድ: ${totalRedCards}` };
    }

    if (marketId === 80 || mCombined.includes('card') || optLower.includes('cards')) {
        if (homeCards === null || awayCards === null) return { status: 'pending', score: null };
        const totalCards = homeCards + awayCards;
        const won = evalRangeOrExactValue(opt, totalCards);
        if (won !== null) return { status: won ? 'won' : 'lost', score: `ካርድ: ${totalCards}` };
    }

    // =========================================================================
    // 🧩 3. COMBO MARKETS (Total & BTTS [49], 1X2 & Total [25], 1X2 & BTTS [24], DC & BTTS [33])
    // =========================================================================
    const decMatch = opt.match(/(\d+\.\d+)/);
    const comboLine = decMatch ? parseFloat(decMatch[1]) : 2.5;
    const hasOverToken = /(?:^|[\s\/&\-])(over|o)(?:[\s\/&\-\d(]|$)/i.test(opt);
    const hasUnderToken = /(?:^|[\s\/&\-])(under|u)(?:[\s\/&\-\d(]|$)/i.test(opt);
    const hasYesToken = /(?:^|[\s\/&\-])(yes|gg)(?:[\s\/&\-\d]|$)/i.test(opt);
    const hasNoToken = /(?:^|[\s\/&\-])(no|ng)(?:[\s\/&\-\d]|$)/i.test(opt);

    const isComboMarket =
        [24, 25, 33, 49].includes(marketId) ||
        mCombined.includes('&') ||
        (mCombined.includes('total') && mCombined.includes('both teams')) ||
        ((hasOverToken || hasUnderToken) && (hasYesToken || hasNoToken));

    if (isComboMarket) {
        const ouPass = hasOverToken ? ftTotal > comboLine : hasUnderToken ? ftTotal < comboLine : null;
        const bttsPass = hasYesToken ? isGG : hasNoToken ? isNG : null;

        if (marketId === 49 || (mCombined.includes('total') && mCombined.includes('both teams')) || (ouPass !== null && bttsPass !== null)) {
            if (ouPass !== null && bttsPass !== null) {
                return { status: (ouPass && bttsPass) ? 'won' : 'lost', score: defaultScoreStr };
            }
        }

        if (marketId === 33 || (mCombined.includes('double chance') && mCombined.includes('both teams'))) {
            let dcPass = null;
            if (/1x|home\s*\/\s*draw|home\s+or\s+draw/i.test(opt)) dcPass = (is1 || isX);
            else if (/x2|draw\s*\/\s*away|draw\s+or\s+away/i.test(opt)) dcPass = (is2 || isX);
            else if (/12|home\s*\/\s*away|home\s+or\s+away/i.test(opt)) dcPass = (is1 || is2);
            if (dcPass !== null && bttsPass !== null) {
                return { status: (dcPass && bttsPass) ? 'won' : 'lost', score: defaultScoreStr };
            }
        }

        if (marketId === 25 || (mCombined.includes('1x2') && mCombined.includes('total')) || (ouPass !== null && /[\/&\-]/.test(opt))) {
            let resPass = null;
            if (/\b(home|1|w1)\b/i.test(opt) || optLower.startsWith('1/') || optLower.startsWith('home/')) resPass = is1;
            else if (/\b(draw|x)\b/i.test(opt) || optLower.startsWith('x/')) resPass = isX;
            else if (/\b(away|2|w2)\b/i.test(opt) || optLower.startsWith('2/') || optLower.startsWith('away/')) resPass = is2;
            if (resPass !== null && ouPass !== null) {
                return { status: (resPass && ouPass) ? 'won' : 'lost', score: defaultScoreStr };
            }
        }

        if (marketId === 24 || (mCombined.includes('1x2') && mCombined.includes('both teams')) || (bttsPass !== null && /[\/&\-]/.test(opt))) {
            let resPass = null;
            if (/\b(home|1|w1)\b/i.test(opt) || optLower.startsWith('1/') || optLower.startsWith('home/')) resPass = is1;
            else if (/\b(draw|x)\b/i.test(opt) || optLower.startsWith('x/')) resPass = isX;
            else if (/\b(away|2|w2)\b/i.test(opt) || optLower.startsWith('2/') || optLower.startsWith('away/')) resPass = is2;
            if (resPass !== null && bttsPass !== null) {
                return { status: (resPass && bttsPass) ? 'won' : 'lost', score: defaultScoreStr };
            }
        }
    }

    // =========================================================================
    // ⏱️ 4. 10 MINUTES RESULT (Market 54)
    // =========================================================================
    if (marketId === 54 || mCombined.includes('10 minutes')) {
        if (ftTotal > 0 && !hasEvents) return { status: 'pending', score: defaultScoreStr };
        const h10 = goalEvents.filter(g => g.team === 'home' && g.time <= 10).length;
        const a10 = goalEvents.filter(g => g.team === 'away' && g.time <= 10).length;
        const score10 = `10' (${h10}:${a10}) / FT ${defaultScoreStr}`;
        if (isOpt1) return { status: h10 > a10 ? 'won' : 'lost', score: score10 };
        if (isOptX) return { status: h10 === a10 ? 'won' : 'lost', score: score10 };
        if (isOpt2) return { status: a10 > h10 ? 'won' : 'lost', score: score10 };
        const ou10 = evalOUPickValue(opt, h10 + a10);
        if (ou10 !== null) return { status: ou10 ? 'won' : 'lost', score: score10 };
    }

    // =========================================================================
    // 🏃‍♂️ 5. GOALSCORERS & FIRST/LAST GOAL (92, 93, 94, 14, 15)
    // =========================================================================
    if ([92, 93, 94].includes(marketId) || mCombined.includes('goalscorer') || mCombined.includes('player to score')) {
        if (!hasEvents && ftTotal > 0) return { status: 'pending', score: defaultScoreStr };
        if (ftTotal === 0) {
            const isNoScorer = optLower.includes('none') || optLower.includes('no goal');
            return { status: isNoScorer ? 'won' : 'lost', score: defaultScoreStr };
        }
        if (marketId === 93 || mCombined.includes('first goalscorer')) {
            const first = goalEvents[0]?.player || '';
            return { status: (first && (first.includes(optLower) || optLower.includes(first))) ? 'won' : 'lost', score: defaultScoreStr };
        }
        if (marketId === 94 || mCombined.includes('last goalscorer')) {
            const last = goalEvents[goalEvents.length - 1]?.player || '';
            return { status: (last && (last.includes(optLower) || optLower.includes(last))) ? 'won' : 'lost', score: defaultScoreStr };
        }
        const hasScored = goalEvents.some(ev => ev.player && (ev.player.includes(optLower) || optLower.includes(ev.player)));
        return { status: hasScored ? 'won' : 'lost', score: defaultScoreStr };
    }

    if (marketId === 14 || mCombined.includes('first goal') || mCombined.includes('first team to score') || mCombined.includes('team to score first')) {
        if (ftTotal === 0) {
            return { status: (optLower === 'none' || optLower === 'no goal' || isOptX) ? 'won' : 'lost', score: defaultScoreStr };
        }
        const firstSide = hasEvents ? goalEvents[0]?.team : (ftHome > 0 && ftAway === 0 ? 'home' : ftAway > 0 && ftHome === 0 ? 'away' : null);
        if (!firstSide) return { status: 'pending', score: defaultScoreStr };
        if (optLower === 'none' || optLower === 'no goal') return { status: 'lost', score: defaultScoreStr };
        if (isOpt1) return { status: firstSide === 'home' ? 'won' : 'lost', score: defaultScoreStr };
        if (isOpt2) return { status: firstSide === 'away' ? 'won' : 'lost', score: defaultScoreStr };
    }

    if (marketId === 15 || mCombined.includes('last goal')) {
        if (ftTotal === 0) {
            return { status: (optLower === 'none' || optLower === 'no goal' || isOptX) ? 'won' : 'lost', score: defaultScoreStr };
        }
        const lastSide = hasEvents ? goalEvents[goalEvents.length - 1]?.team : (ftHome > 0 && ftAway === 0 ? 'home' : ftAway > 0 && ftHome === 0 ? 'away' : null);
        if (!lastSide) return { status: 'pending', score: defaultScoreStr };
        if (optLower === 'none' || optLower === 'no goal') return { status: 'lost', score: defaultScoreStr };
        if (isOpt1) return { status: lastSide === 'home' ? 'won' : 'lost', score: defaultScoreStr };
        if (isOpt2) return { status: lastSide === 'away' ? 'won' : 'lost', score: defaultScoreStr };
    }

    // =========================================================================
    // ⚖️ 6. HANDICAP (Asian [4] & European [56, 239] — ማስታወሻ: marketId 9 2nd Half Goals ነው!)
    // =========================================================================
    if (marketId === 4 || marketId === 56 || marketId === 239 || mCombined.includes('handicap')) {
        const hcPeriod = getPeriodGoals(mCombined);
        if (!hcPeriod) return { status: 'pending', score: defaultScoreStr };
        const hcValue = line;
        let adjustedHome = hcPeriod.home, adjustedAway = hcPeriod.away;

        if (isOpt1 || optLower.includes('home') || optLower.startsWith('1')) adjustedHome += hcValue;
        else if (isOpt2 || optLower.includes('away') || optLower.startsWith('2')) adjustedAway += hcValue;
        else if (isOptX) adjustedHome += hcValue;

        const isAsian = marketId === 4 || opt.includes('.5') || opt.includes('.25') || opt.includes('.75');
        if (isAsian) {
            if (isOpt1 || optLower.includes('home') || optLower.startsWith('1')) {
                return { status: adjustedHome > adjustedAway ? 'won' : (adjustedHome === adjustedAway ? 'void' : 'lost'), score: hcPeriod.label };
            }
            if (isOpt2 || optLower.includes('away') || optLower.startsWith('2')) {
                return { status: adjustedAway > adjustedHome ? 'won' : (adjustedHome === adjustedAway ? 'void' : 'lost'), score: hcPeriod.label };
            }
        } else {
            if (isOpt1 || optLower.includes('home') || optLower.startsWith('1')) return { status: adjustedHome > adjustedAway ? 'won' : 'lost', score: hcPeriod.label };
            if (isOptX) return { status: adjustedHome === adjustedAway ? 'won' : 'lost', score: hcPeriod.label };
            if (isOpt2 || optLower.includes('away') || optLower.startsWith('2')) return { status: adjustedAway > adjustedHome ? 'won' : 'lost', score: hcPeriod.label };
        }
    }

    // =========================================================================
    // 🛡️ 7. ልዩ ማርኬቶች (Exact Goals [38], Draw No Bet [2], Win Either/Both Halves [36, 37],
    //       Highest Scoring Half [11], Which Team To Score [62], Score in Both Halves [39], Both Halves Over 1.5 [35])
    // =========================================================================
    if (marketId === 38 || mCombined.includes('exact goals')) {
        const egPeriod = getPeriodGoals(mCombined);
        if (!egPeriod) return { status: 'pending', score: defaultScoreStr };
        const won = evalRangeOrExactValue(opt, egPeriod.home + egPeriod.away);
        if (won !== null) return { status: won ? 'won' : 'lost', score: egPeriod.label };
    }

    if (marketId === 2 || mCombined.includes('draw no bet')) {
        const dnbPeriod = getPeriodGoals(mCombined);
        if (!dnbPeriod) return { status: 'pending', score: defaultScoreStr };
        if (dnbPeriod.home === dnbPeriod.away) return { status: 'void', score: dnbPeriod.label };
        if (isOpt1) return { status: dnbPeriod.home > dnbPeriod.away ? 'won' : 'lost', score: dnbPeriod.label };
        if (isOpt2) return { status: dnbPeriod.away > dnbPeriod.home ? 'won' : 'lost', score: dnbPeriod.label };
    }

    if (marketId === 36 || mCombined.includes('win both halves')) {
        if (htHome === null || htAway === null) return { status: 'pending', score: defaultScoreStr };
        const hBoth = htHome > htAway && stHome > stAway;
        const aBoth = htAway > htHome && stAway > stHome;
        const lbl = `1H ${htHome}:${htAway} / 2H ${stHome}:${stAway}`;
        if (mCombined.includes('home') || isOpt1) return { status: (optLower === 'no' ? !hBoth : hBoth) ? 'won' : 'lost', score: lbl };
        if (mCombined.includes('away') || isOpt2) return { status: (optLower === 'no' ? !aBoth : aBoth) ? 'won' : 'lost', score: lbl };
    }

    if (marketId === 37 || mCombined.includes('win either half') || mCombined.includes('to win either half')) {
        if (htHome === null || htAway === null) return { status: 'pending', score: defaultScoreStr };
        const homeWinsAHalf = (htHome > htAway) || (stHome > stAway);
        const awayWinsAHalf = (htAway > htHome) || (stAway > stHome);
        const lbl = `1H ${htHome}:${htAway} / 2H ${stHome}:${stAway}`;
        if (mCombined.includes('home') || isOpt1) return { status: (optLower === 'no' ? !homeWinsAHalf : homeWinsAHalf) ? 'won' : 'lost', score: lbl };
        if (mCombined.includes('away') || isOpt2) return { status: (optLower === 'no' ? !awayWinsAHalf : awayWinsAHalf) ? 'won' : 'lost', score: lbl };
    }

    if (marketId === 39 || mCombined.includes('score in both halves')) {
        if (htHome === null || htAway === null) return { status: 'pending', score: defaultScoreStr };
        const lbl = `1H ${htHome}:${htAway} / 2H ${stHome}:${stAway}`;
        const bothScored = htTotal > 0 && stTotal > 0;
        if (optLower === 'yes' || optLower === 'gg') return { status: bothScored ? 'won' : 'lost', score: lbl };
        if (optLower === 'no' || optLower === 'ng') return { status: !bothScored ? 'won' : 'lost', score: lbl };
    }

    if (marketId === 35 || mCombined.includes('both halves over 1.5')) {
        if (htHome === null || htAway === null) return { status: 'pending', score: defaultScoreStr };
        const lbl = `1H ${htHome}:${htAway} / 2H ${stHome}:${stAway}`;
        const bothOver = htTotal > 1.5 && stTotal > 1.5;
        if (optLower === 'yes' || optLower === 'gg') return { status: bothOver ? 'won' : 'lost', score: lbl };
        if (optLower === 'no' || optLower === 'ng') return { status: !bothOver ? 'won' : 'lost', score: lbl };
    }

    if (marketId === 11 || mCombined.includes('highest scoring half')) {
        if (htTotal === null || stTotal === null) return { status: 'pending', score: defaultScoreStr };
        const lbl = `1H ${htHome}:${htAway} / 2H ${stHome}:${stAway}`;
        if (optLower.includes('1st') || optLower.includes('first') || opt === '1') return { status: htTotal > stTotal ? 'won' : 'lost', score: lbl };
        if (optLower.includes('2nd') || optLower.includes('second') || opt === '2') return { status: stTotal > htTotal ? 'won' : 'lost', score: lbl };
        if (optLower.includes('draw') || optLower.includes('equal') || optLower === 'x') return { status: htTotal === stTotal ? 'won' : 'lost', score: lbl };
    }

    if (marketId === 62 || mCombined.includes('which team to score')) {
        if (optLower.includes('only home') || isOpt1 || optLower === 'home') return { status: (ftHome > 0 && ftAway === 0) ? 'won' : 'lost', score: defaultScoreStr };
        if (optLower.includes('only away') || isOpt2 || optLower === 'away') return { status: (ftAway > 0 && ftHome === 0) ? 'won' : 'lost', score: defaultScoreStr };
        if (optLower.includes('both') || optLower === 'yes') return { status: isGG ? 'won' : 'lost', score: defaultScoreStr };
        if (optLower.includes('none') || optLower.includes('neither') || optLower === 'no' || isOptX) return { status: (ftHome === 0 && ftAway === 0) ? 'won' : 'lost', score: defaultScoreStr };
    }

    // =========================================================================
    // ⚽ 8. HALFTIME/FULLTIME (Market 7 — "1/2", "Home/Away", ወይም ያለ ስላሽ "12", "1X", "X2", "11")
    // =========================================================================
    if (marketId === 7 || mCombined.includes('halftime/fulltime') || mCombined.includes('ht/ft')) {
        let expectedHT = null;
        let expectedFT = null;
        if (/[\/\-]/.test(opt)) {
            const parts = opt.split(/[\/\-]/).map(s => s.trim().toLowerCase()).filter(Boolean);
            if (parts.length === 2) {
                expectedHT = parts[0];
                expectedFT = parts[1];
            }
        } else if (/^[12xX]{2}$/.test(opt)) {
            expectedHT = opt[0].toLowerCase();
            expectedFT = opt[1].toLowerCase();
        }

        if (expectedHT && expectedFT) {
            const mapRes = (val) => {
                if (val === 'home' || val === homeName || val === 'w1' || val === '1') return '1';
                if (val === 'away' || val === awayName || val === 'w2' || val === '2') return '2';
                if (val === 'draw' || val === 'x') return 'x';
                return val;
            };
            const targetHT = mapRes(expectedHT);
            const targetFT = mapRes(expectedFT);
            const ftRes = is1 ? '1' : isX ? 'x' : '2';

            if (ftRes !== targetFT) {
                const lbl = htHome !== null ? `1H ${htHome}:${htAway} / FT ${defaultScoreStr}` : `FT ${defaultScoreStr}`;
                return { status: 'lost', score: lbl };
            }
            if (htHome === null || htAway === null) {
                if (targetHT === '1' && ftHome === 0) return { status: 'lost', score: `FT ${defaultScoreStr}` };
                if (targetHT === '2' && ftAway === 0) return { status: 'lost', score: `FT ${defaultScoreStr}` };
                return { status: 'pending', score: `FT ${defaultScoreStr}` };
            }
            const htRes = htHome > htAway ? '1' : htHome === htAway ? 'x' : '2';
            return {
                status: (htRes === targetHT && ftRes === targetFT) ? 'won' : 'lost',
                score: `1H ${htHome}:${htAway} / FT ${defaultScoreStr}`
            };
        }
    }

    // =========================================================================
    // ⚽ 9. DOUBLE CHANCE (Market 12, 32)
    // =========================================================================
    if (marketId === 12 || marketId === 32 || mCombined.includes('double chance')) {
        const dcPeriod = getPeriodGoals(marketId === 32 ? '1st half' : mCombined);
        if (!dcPeriod) return { status: 'pending', score: defaultScoreStr };
        const dc1 = dcPeriod.home > dcPeriod.away;
        const dcX = dcPeriod.home === dcPeriod.away;
        const dc2 = dcPeriod.away > dcPeriod.home;
        if (optLower === '1x' || optLower.includes('home/draw') || optLower.includes('home or draw')) return { status: (dc1 || dcX) ? 'won' : 'lost', score: dcPeriod.label };
        if (optLower === '12' || optLower.includes('home/away') || optLower.includes('home or away')) return { status: (dc1 || dc2) ? 'won' : 'lost', score: dcPeriod.label };
        if (optLower === 'x2' || optLower.includes('draw/away') || optLower.includes('draw or away')) return { status: (dc2 || dcX) ? 'won' : 'lost', score: dcPeriod.label };
    }

    // =========================================================================
    // 🥅 10. GOALS (BTTS [8, 34, 26], Over/Under [5, 6, 9, 16, 17, 50], Correct Score [10, 31], Odd/Even [21, 22], Range [349], Clean Sheet [19, 20], Win to Nil [27, 28])
    // =========================================================================
    if ([8, 34, 26].includes(marketId) || mCombined.includes('both teams to score') || mCombined.includes('btts')) {
        const periodTag = marketId === 34 ? '1st half' : marketId === 26 ? '2nd half' : mCombined;
        const bttsPeriod = getPeriodGoals(periodTag);
        if (!bttsPeriod) return { status: 'pending', score: defaultScoreStr };
        const periodGG = bttsPeriod.home > 0 && bttsPeriod.away > 0;
        if (optLower === 'yes' || optLower.includes('gg')) return { status: periodGG ? 'won' : 'lost', score: bttsPeriod.label };
        if (optLower === 'no' || optLower.includes('ng')) return { status: !periodGG ? 'won' : 'lost', score: bttsPeriod.label };
    }

    if ([5, 6, 9, 16, 17, 50].includes(marketId) || mCombined.includes('total goals') || mCombined.includes('over/under') || mCombined.includes('goals over/under') || mCombined === 'totals') {
        let targetTotal = ftTotal;
        let scoreLabel = defaultScoreStr;

        if (marketId === 6 || mCombined.includes('1st half') || mCombined.includes('first half')) {
            if (htTotal === null) return { status: 'pending', score: defaultScoreStr };
            targetTotal = mCombined.includes('home') ? htHome : mCombined.includes('away') ? htAway : htTotal;
            scoreLabel = `1H ${htHome}:${htAway} (FT ${defaultScoreStr})`;
        } else if (marketId === 9 || mCombined.includes('2nd half') || mCombined.includes('second half')) {
            if (stTotal === null) return { status: 'pending', score: defaultScoreStr };
            targetTotal = mCombined.includes('home') ? stHome : mCombined.includes('away') ? stAway : stTotal;
            scoreLabel = `2H ${stHome}:${stAway} (FT ${defaultScoreStr})`;
        } else if (marketId === 16 || mCombined.includes('home total') || mCombined.includes('home team') || mCombined.includes('total - home')) {
            targetTotal = ftHome;
        } else if (marketId === 17 || mCombined.includes('away total') || mCombined.includes('away team') || mCombined.includes('total - away')) {
            targetTotal = ftAway;
        }

        const won = evalRangeOrExactValue(opt, targetTotal);
        if (won !== null) return { status: won ? 'won' : 'lost', score: scoreLabel };
    }

    if (marketId === 10 || marketId === 31 || mCombined.includes('correct score')) {
        const csPeriod = getPeriodGoals(marketId === 31 ? '1st half' : mCombined);
        if (!csPeriod) return { status: 'pending', score: defaultScoreStr };
        const m = opt.match(/(\d+)\s*[:\-]\s*(\d+)/);
        if (m) {
            const pH = parseInt(m[1], 10);
            const pA = parseInt(m[2], 10);
            return { status: (csPeriod.home === pH && csPeriod.away === pA) ? 'won' : 'lost', score: csPeriod.label };
        }
    }

    if (marketId === 21 || marketId === 22 || mCombined.includes('odd/even')) {
        const oePeriod = getPeriodGoals(marketId === 22 ? '1st half' : mCombined);
        if (!oePeriod) return { status: 'pending', score: defaultScoreStr };
        const isEven = (oePeriod.home + oePeriod.away) % 2 === 0;
        if (optLower.includes('even')) return { status: isEven ? 'won' : 'lost', score: oePeriod.label };
        if (optLower.includes('odd')) return { status: !isEven ? 'won' : 'lost', score: oePeriod.label };
    }

    if (marketId === 349 || mCombined.includes('goal range') || mCombined.includes('multi goal') || mCombined.includes('multigoal')) {
        const grPeriod = getPeriodGoals(mCombined);
        if (!grPeriod) return { status: 'pending', score: defaultScoreStr };
        const won = evalRangeOrExactValue(opt, grPeriod.home + grPeriod.away);
        if (won !== null) return { status: won ? 'won' : 'lost', score: grPeriod.label };
    }

    if (marketId === 19 || marketId === 20 || mCombined.includes('clean sheet')) {
        if (marketId === 19 || optLower.includes('home') || mCombined.includes('home')) {
            if (optLower.includes('yes')) return { status: ftAway === 0 ? 'won' : 'lost', score: defaultScoreStr };
            if (optLower.includes('no')) return { status: ftAway > 0 ? 'won' : 'lost', score: defaultScoreStr };
        }
        if (marketId === 20 || optLower.includes('away') || mCombined.includes('away')) {
            if (optLower.includes('yes')) return { status: ftHome === 0 ? 'won' : 'lost', score: defaultScoreStr };
            if (optLower.includes('no')) return { status: ftHome > 0 ? 'won' : 'lost', score: defaultScoreStr };
        }
    }

    if (marketId === 27 || marketId === 28 || mCombined.includes('win to nil')) {
        if (marketId === 27 || isOpt1 || optLower.includes('home') || mCombined.includes('home')) {
            if (optLower.includes('yes')) return { status: (is1 && ftAway === 0) ? 'won' : 'lost', score: defaultScoreStr };
            if (optLower.includes('no')) return { status: !(is1 && ftAway === 0) ? 'won' : 'lost', score: defaultScoreStr };
        }
        if (marketId === 28 || isOpt2 || optLower.includes('away') || mCombined.includes('away')) {
            if (optLower.includes('yes')) return { status: (is2 && ftHome === 0) ? 'won' : 'lost', score: defaultScoreStr };
            if (optLower.includes('no')) return { status: !(is2 && ftHome === 0) ? 'won' : 'lost', score: defaultScoreStr };
        }
    }

    // =========================================================================
    // ⚽ 11. MATCH WINNER (1X2: Market 1, 13 [1st Half], 3 [2nd Half])
    // =========================================================================
    if (marketId === 1 || marketId === 13 || marketId === 3 || ['1', 'x', '2', 'draw'].includes(optLower) || isOpt1 || isOptX || isOpt2) {
        if (marketId === 13 || mCombined.includes('1st half') || mCombined.includes('first half')) {
            if (htHome === null || htAway === null) return { status: 'pending', score: defaultScoreStr };
            const lbl = `1H ${htHome}:${htAway} (FT ${defaultScoreStr})`;
            if (isOpt1) return { status: htHome > htAway ? 'won' : 'lost', score: lbl };
            if (isOptX) return { status: htHome === htAway ? 'won' : 'lost', score: lbl };
            if (isOpt2) return { status: htAway > htHome ? 'won' : 'lost', score: lbl };
        } else if (marketId === 3 || mCombined.includes('2nd half') || mCombined.includes('second half')) {
            if (stHome === null || stAway === null) return { status: 'pending', score: defaultScoreStr };
            const lbl = `2H ${stHome}:${stAway} (FT ${defaultScoreStr})`;
            if (isOpt1) return { status: stHome > stAway ? 'won' : 'lost', score: lbl };
            if (isOptX) return { status: stHome === stAway ? 'won' : 'lost', score: lbl };
            if (isOpt2) return { status: stAway > stHome ? 'won' : 'lost', score: lbl };
        } else {
            if (isOpt1) return { status: is1 ? 'won' : 'lost', score: defaultScoreStr };
            if (isOptX) return { status: isX ? 'won' : 'lost', score: defaultScoreStr };
            if (isOpt2) return { status: is2 ? 'won' : 'lost', score: defaultScoreStr };
        }
    }

    return { status: 'pending', score: defaultScoreStr };
};

const evaluateMarketPick = (pick, match, extraCornerData = null) => {
    return evaluateMarketPickWithScore(pick, match, extraCornerData).status;
};
// ==============================================================================

// ==============================================================================
// 🌟 አውቶማቲክ ክፍያ (Auto Settlement) ማጣሪያ — በየ15 ደቂቃው በፍጥነት የሚሰራ
// ==============================================================================
let isRunningSettlement = false;
const runAutoSettlement = async () => {
    if (isRunningSettlement) return;
    isRunningSettlement = true;
    try {
        // ጨዋታው ከጀመረ ቢያንስ 100 ደቂቃ ያለፋቸውን (ወይም ሰዓታቸው ያልተመዘገበ) Pending ትኬቶችን ብቻ ማምጣት (የAPI ኮታ እንዳይባክን)
        const [pendingItems] = await db.query(`
            SELECT ti.id, ti.fixture_id, ti.odd_name, ti.odd_id, ti.market_id, ti.market_key, ti.market_name, ti.match_info, sm.commence_time
            FROM ticket_items ti
            LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id
            WHERE ti.match_status IN ('pending', 'manual')
              AND (sm.commence_time IS NULL OR sm.commence_time < NOW() - INTERVAL 100 MINUTE)
        `);
        if (pendingItems.length === 0) return;

        // 🌟 ወሳኝ ማስተካከያ፡ API-Football '/fixtures?ids=' ቁጥር (Integer) ብቻ ስለሚቀበል፣ ቁጥር የሆኑትንና ያልሆኑትን መለየት 🌟
        const allRawFixtureIds = [...new Set(pendingItems.map(p => String(p.fixture_id ?? '').trim()).filter(Boolean))];
        const numericFixtureIds = allRawFixtureIds.filter(id => /^\d+$/.test(id));
        const nonNumericFixtureIds = allRawFixtureIds.filter(id => !/^\d+$/.test(id));

        const apiKeys = await getApiKeysArray();
        const unresolvedNumericIds = new Set(numericFixtureIds);

        // 1A. ቁጥር (Integer) የሆኑ የ API-Football fixture_id ዎችን በ20 ከፍሎ መጠየቅ
        if (numericFixtureIds.length > 0 && apiKeys.length > 0) {
            const client = createApiClient(apiKeys, 'https://v3.football.api-sports.io');
            const chunkedIds = [];
            for (let i = 0; i < numericFixtureIds.length; i += 20) {
                chunkedIds.push(numericFixtureIds.slice(i, i + 20));
            }

            for (const idsChunk of chunkedIds) {
                if (!client.hasKeys()) break;
                try {
                    const queryParam = idsChunk.length === 1
                        ? { id: idsChunk[0] }
                        : { ids: idsChunk.join('-') };
                    const resp = await client.get('/fixtures', queryParam);

                    for (const match of (resp?.data?.response || [])) {
                        const mIdStr = String(match.fixture.id);
                        const status = match.fixture.status.short;

                        const isCompleted = ['FT', 'PEN', 'AET'].includes(status);
                        const isCancelledOrPostponed = ['PST', 'CANC', 'ABD', 'WO'].includes(status);

                        await db.query(`UPDATE saved_matches SET match_status = ? WHERE id = ?`, [status, mIdStr]);

                        const associatedPicks = pendingItems.filter(p => String(p.fixture_id).trim() === mIdStr);

                        if (isCancelledOrPostponed) {
                            unresolvedNumericIds.delete(mIdStr);
                            for (let pick of associatedPicks) {
                                await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", ['postponed', 'POSTPONED', pick.id]);
                            }
                            continue;
                        }

                        if (isCompleted) {
                            unresolvedNumericIds.delete(mIdStr);
                            const needsExtraCorners = associatedPicks.some(p => {
                                const mName = `${p.market_name || ''} ${p.odd_name || ''}`.toLowerCase();
                                return mName.includes('corner') && (mName.includes('1st half') || mName.includes('first half') || mName.includes('2nd half') || mName.includes('second half') || !match.statistics || match.statistics.length < 2);
                            });

                            let extraCornerData = null;
                            if (needsExtraCorners) {
                                extraCornerData = await fetchSofaHalfCorners(match.teams?.home?.name, match.teams?.away?.name);
                            }

                            for (let pick of associatedPicks) {
                                const evalRes = evaluateMarketPickWithScore(pick, match, extraCornerData);
                                const normalizedStatus = evalRes.status === 'void' ? 'postponed' : evalRes.status;

                                if (normalizedStatus === 'won' || normalizedStatus === 'lost' || normalizedStatus === 'postponed') {
                                    const fullScore = evalRes.score || `${match.score?.fulltime?.home ?? 0}:${match.score?.fulltime?.away ?? 0}`;
                                    const compactScore = fullScore.match(/\d+\s*:\s*\d+(?:\s*\(\d+\))?/)?.[0] || fullScore.slice(0, 15);
                                    try {
                                        await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", [normalizedStatus, fullScore, pick.id]);
                                    } catch (colErr) {
                                        await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", [normalizedStatus, compactScore, pick.id]).catch(() => {});
                                    }
                                }
                            }
                        }
                    }
                } catch (err) { }
            }
        }

        // 1B. የAPI-Football ኮታ ቢያልቅ ወይም የድሮ (Non-Numeric) IDs ካሉ ወዲያውኑ በነፃ ከ SofaScore በቡድን ስም በማምጣት ማወራረድ
        const fallbackIdsToCheck = [...nonNumericFixtureIds, ...Array.from(unresolvedNumericIds)];
        if (fallbackIdsToCheck.length > 0) {
            for (const fallbackId of fallbackIdsToCheck) {
                const associatedPicks = pendingItems.filter(p => String(p.fixture_id).trim() === fallbackId);
                if (associatedPicks.length === 0) continue;

                const sampleInfo = String(associatedPicks[0].match_info || '');
                const teams = sampleInfo.split(/\s+vs\.?\s+|\s+-\s+/i);
                const homeTeam = (teams[0] || '').trim();
                const awayTeam = (teams[1] || '').trim();
                if (!homeTeam || !awayTeam) continue;

                const sofaFallback = await fetchFallbackMatchFromSofaByNames(homeTeam, awayTeam);
                if (!sofaFallback || !sofaFallback.match) continue;

                const { match, extraCornerData } = sofaFallback;
                const status = match.fixture.status.short;

                if (status === 'PST') {
                    for (let pick of associatedPicks) {
                        await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", ['postponed', 'POSTPONED', pick.id]);
                    }
                } else if (status === 'FT') {
                    for (let pick of associatedPicks) {
                        const evalRes = evaluateMarketPickWithScore(pick, match, extraCornerData);
                        const normalizedStatus = evalRes.status === 'void' ? 'postponed' : evalRes.status;

                        if (normalizedStatus === 'won' || normalizedStatus === 'lost' || normalizedStatus === 'postponed') {
                            const fullScore = evalRes.score || `${match.score?.fulltime?.home ?? 0}:${match.score?.fulltime?.away ?? 0}`;
                            const compactScore = fullScore.match(/\d+\s*:\s*\d+(?:\s*\(\d+\))?/)?.[0] || fullScore.slice(0, 15);
                            try {
                                await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", [normalizedStatus, fullScore, pick.id]);
                            } catch (colErr) {
                                await db.query("UPDATE ticket_items SET match_status = ?, score = ? WHERE id = ?", [normalizedStatus, compactScore, pick.id]).catch(() => {});
                            }
                        }
                    }
                }
            }
        }

        // 2. ትክክለኛው የትኬት እና የገንዘብ ክፍያ ስሌት 
        const [ticketsToCheck] = await db.query(`
            SELECT t.id, t.user_id, t.stake_amount, t.status, t.created_at, u.role 
            FROM tickets t 
            LEFT JOIN users u ON t.user_id = u.id 
            WHERE t.ticket_number IS NOT NULL
              AND t.status IN ('active', 'pending', 'manual_review')
        `);

        for (let tkt of ticketsToCheck) {
            const [items] = await db.query(`
                SELECT ti.match_status, ti.odd_value, sm.commence_time
                FROM ticket_items ti
                LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id
                WHERE ti.ticket_id = ?
            `, [tkt.id]);
            if (items.length === 0) continue;

            let hasLost = false;
            let hasPending = false;
            let calculatedOdds = 1;
            let lastMatchTime = new Date(tkt.created_at).getTime();

            // የእያንዳንዱን ጨዋታ ኦድ እናባዛለን (Void/Postponed ከሆነ ኦዱ ወደ 1 ይቀየራል)
            for (let item of items) {
                const mTime = new Date(item.commence_time || tkt.created_at).getTime();
                if (!Number.isNaN(mTime) && mTime > lastMatchTime) lastMatchTime = mTime;

                if (item.match_status === 'lost') {
                    hasLost = true;
                } else if (item.match_status === 'won') {
                    calculatedOdds *= parseFloat(item.odd_value);
                } else if (['void', 'postponed', 'cancelled', 'abandoned'].includes(item.match_status)) {
                    calculatedOdds *= 1;
                } else {
                    hasPending = true;
                }
            }

            if (hasLost) {
                await db.query(`UPDATE tickets SET status = 'lost' WHERE id = ? AND status NOT IN ('paid', 'void', 'expired')`, [tkt.id]);
                continue;
            }

            if (hasPending) continue; // ገና ያላለቀ ጨዋታ አለው

            // 3. ማንም አልተሸነፈም፣ ፔንዲንግም የለም! (ትኬቱ አሸንፏል) 
            const finalWinAmount = Math.min(MAX_PAYOUT_LIMIT, calculatedOdds * parseFloat(tkt.stake_amount)).toFixed(2);
            const isTicketExpired = Date.now() > lastMatchTime + (72 * 60 * 60 * 1000);
            
            let connection;
            try {
                connection = await db.getConnection();
                await connection.beginTransaction(); // ክፍያ እንዳይደገም Database Lock እናደርጋለን
                
                // ትኬቱ አስቀድሞ አለመከፈሉን ማረጋገጥ (Double Payout Protection)
                const [checkTkt] = await connection.query('SELECT status FROM tickets WHERE id = ? FOR UPDATE', [tkt.id]);
                if (!['active', 'pending', 'manual_review'].includes(checkTkt[0].status)) {
                    await connection.rollback();
                    continue;
                }

                if (tkt.role === 'user') {
                    // ለኦንላይን ተጫዋቾች ቀጥታ ወደ ባላንስ ይገባል
                    await connection.query(`UPDATE tickets SET status = 'paid', potential_win = ?, total_odds = ? WHERE id = ?`, [finalWinAmount, calculatedOdds.toFixed(2), tkt.id]);
                    await connection.query(`UPDATE users SET current_balance = current_balance + ? WHERE id = ?`, [finalWinAmount, tkt.user_id]);
                    await connection.query(
                        `INSERT INTO transactions (user_id, transaction_type, amount, status, ticket_id) VALUES (?, 'bet_winning', ?, 'completed', ?)`,
                        [tkt.user_id, finalWinAmount, tkt.id]
                    );
                } else {
                    // ለካሼር እና ገስት ትኬቶች (ከመጨረሻው ጨዋታ በኋላ 72 ሰዓት ካለፈ expired፣ ካላለፈ won)
                    const nextShopStatus = isTicketExpired ? 'expired' : 'won';
                    await connection.query(`UPDATE tickets SET status = ?, potential_win = ?, total_odds = ? WHERE id = ?`, [nextShopStatus, finalWinAmount, calculatedOdds.toFixed(2), tkt.id]);
                }
                
                await connection.commit();
            } catch (err) {
                if (connection) await connection.rollback();
                console.error('Auto Settlement Transaction Error:', err);
            } finally {
                if (connection) connection.release();
            }
        }

    } catch (error) {
    } finally {
        isRunningSettlement = false;
    }
};

const MAX_PAYOUT_LIMIT = 10000;

let settlementIntervalId = null;

const startCronJobs = () => {
    initializeDatabase();

    // ሰርቨሩ እንደተነሳ በ5 ሰከንድ ውስጥ የመጀመሪያውን የውጤት ማጣሪያ ያካሂዳል
    setTimeout(() => {
        runAutoSettlement().catch(() => {});
    }, 5000);

    // 1. በየ 4 ሰዓቱ አዳዲስ ጨዋታዎችን እና ኦዶችን ማምጣት
    cron.schedule('0 */4 * * *', fetchAndSaveMatches);

    // 2. በየ 15 ደቂቃው (00, 15, 30, 45) ውጤት ቶሎ ቶሎ ማጣራት
    cron.schedule('*/15 * * * *', () => {
        console.log(`\n🔄 [Auto-Settlement] የ15 ደቂቃ አውቶማቲክ የውጤት ማጣሪያ ተጀምሯል (${new Date().toLocaleTimeString()})...`);
        runAutoSettlement().catch(() => {});
    });

    // ተጨማሪ ዋስትና፡ node-cron በሲፒዩ መጨናነቅ ቢዘለል እንኳ በየ15 ደቂቃው የማይቋረጥ Timer
    if (settlementIntervalId) clearInterval(settlementIntervalId);
    settlementIntervalId = setInterval(() => {
        runAutoSettlement().catch(() => {});
    }, 15 * 60 * 1000);

    // 3. በየሰዓቱ ጊዜ ያለፈባቸውን ትኬቶች እና ያልታተሙ ቡኪንግ ኮዶችን ማጽዳት
    cron.schedule('0 * * * *', async () => {
        try {
            // ከመጨረሻው ጨዋታ ሰዓት (ወይም ከተቆረጠበት ሰዓት) 72 ሰዓት ያለፈባቸው ያልተከፈሉ አሸናፊ ትኬቶችን ብቻ ማክሸፍ
            await db.query(`
                UPDATE tickets t
                LEFT JOIN (
                    SELECT ti.ticket_id, MAX(sm.commence_time) AS last_match_time
                    FROM ticket_items ti
                    LEFT JOIN saved_matches sm ON ti.fixture_id = sm.id
                    GROUP BY ti.ticket_id
                ) lm ON lm.ticket_id = t.id
                SET t.status = 'expired'
                WHERE t.status = 'won'
                  AND COALESCE(lm.last_match_time, t.created_at) < NOW() - INTERVAL 72 HOUR
            `);

            // ከ48 ሰዓት በላይ ያልተቆረጡ (ያልታተሙ) የእንግዳ Booking ኮዶችን ማጽዳት
            await db.query(`
                DELETE ti FROM ticket_items ti
                INNER JOIN tickets t ON ti.ticket_id = t.id
                WHERE t.ticket_number IS NULL AND t.status = 'pending' AND t.created_at < NOW() - INTERVAL 48 HOUR
            `);
            await db.query(`
                DELETE FROM tickets
                WHERE ticket_number IS NULL AND status = 'pending' AND created_at < NOW() - INTERVAL 48 HOUR
            `);
        } catch (e) {}
    });
};

module.exports = { startCronJobs, fetchAndSaveMatches, runAutoSettlement, getApiKey, getApiKeysArray, evaluateMarketPick, evaluateMarketPickWithScore };