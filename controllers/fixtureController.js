const axios = require('axios');
const db = require('../config/db');

// የ API ኮታ እንዳያልቅብን ያመጣነውን ዳታ ለ 10 ደቂቃ እዚህ ውስጥ እናስቀምጠዋለን (Caching)
const cache = {};
const CACHE_TIME = 10 * 60 * 1000; // 10 ደቂቃ

// የሊግ ስሞችን ከ The Odds API ኮዶች ጋር ማገናኘት
// የሊግ ስሞችን ከ The Odds API ኮዶች ጋር ማገናኘት
const LEAGUE_KEYS = {
    // ዋና ዋና ሊጎች
    'Premier League': 'soccer_epl',
    'LaLiga': 'soccer_spain_la_liga',
    'Serie A': 'soccer_italy_serie_a',
    'Bundesliga': 'soccer_germany_bundesliga',
    'Ligue 1': 'soccer_france_ligue_one',
    'Champions League': 'soccer_uefa_champs_league',
    'Europa League': 'soccer_uefa_europa_league',

    // አዳዲስ ታዋቂ ሊጎች
    'Eredivisie (Netherlands)': 'soccer_netherlands_eredivisie',
    'Primeira Liga (Portugal)': 'soccer_portugal_primeira_liga',
    'Super Lig (Turkey)': 'soccer_turkey_super_league',
    'MLS (USA)': 'soccer_usa_mls',

    // 2ኛ ዲቪዚዮን ሊጎች
    'Championship (England)': 'soccer_efl_champ',
    'LaLiga 2 (Spain)': 'soccer_spain_segunda_division',
    'Serie B (Italy)': 'soccer_italy_serie_b',
    'Bundesliga 2 (Germany)': 'soccer_germany_bundesliga2',
    'Ligue 2 (France)': 'soccer_france_ligue_two'
};

// 🌟 ማስተካከያ፡ የ API Key ከዳታቤዝ እንዲያነብ አድርጌዋለሁ (Hardcode እንዳይሆን)
const getDynamicApiKey = async () => {
    try {
        const [keys] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'odds_api_key'");
        if (keys.length > 0 && keys[0].setting_value) return keys[0].setting_value.trim();
    } catch (e) { }
    return 'f11dba0d713af326f47a1496e754735f'; // የድሮው ዲፎልት
};

const getFixtures = async (req, res) => {
    try {
        const API_KEY = await getDynamicApiKey();
        const requestedLeague = req.query.league || 'Premier League';
        const sportKey = LEAGUE_KEYS[requestedLeague] || 'soccer_epl';

        // 1. ዳታው ከዚህ በፊት መጥቶ Cache ውስጥ ካለ፣ አዲስ API ሳንጠራ እሱን እንመልሳለን
        if (cache[sportKey] && (Date.now() - cache[sportKey].timestamp < CACHE_TIME)) {
            console.log(`ከ Cache የተወሰደ: ${requestedLeague}`);
            return res.json({ success: true, data: cache[sportKey].data });
        }

        // 2. Cache ውስጥ ከሌለ አዲስ API እንጠራለን
        const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${API_KEY}&regions=uk,eu&markets=h2h`;
        const response = await axios.get(url);
        
        console.log(`አዲስ API ተጠርቷል: ${requestedLeague}`);

        let formattedData = [];

        if (response.data && response.data.length > 0) {
            formattedData = response.data.slice(0, 15).map(game => {
                let odd1 = 1.0, oddX = 1.0, odd2 = 1.0;

                if (game.bookmakers && game.bookmakers.length > 0) {
                    const market = game.bookmakers[0].markets.find(m => m.key === 'h2h');
                    if (market && market.outcomes) {
                        const homeOutcome = market.outcomes.find(o => o.name === game.home_team);
                        const awayOutcome = market.outcomes.find(o => o.name === game.away_team);
                        const drawOutcome = market.outcomes.find(o => o.name.toLowerCase() === 'draw');

                        if (homeOutcome) odd1 = homeOutcome.price;
                        if (drawOutcome) oddX = drawOutcome.price;
                        if (awayOutcome) odd2 = awayOutcome.price;
                    }
                }

                return {
                    id: game.id,
                    home_team: game.home_team,
                    away_team: game.away_team,
                    match_time: game.commence_time,
                    odds: [
                        { odd_id: `1_${game.id}`, option: "1", value: odd1.toFixed(2) },
                        { odd_id: `x_${game.id}`, option: "X", value: oddX.toFixed(2) },
                        { odd_id: `2_${game.id}`, option: "2", value: odd2.toFixed(2) }
                    ]
                };
            });
        }

        // 3. ያመጣነውን ዳታ ለቀጣይ 10 ደቂቃ Cache ውስጥ እናስቀምጠዋለን
        if (formattedData.length > 0) {
            cache[sportKey] = {
                timestamp: Date.now(),
                data: formattedData
            };
        }

        res.json({ success: true, data: formattedData });

    } catch (error) {
        console.error("The Odds API Error:", error.message);
        res.status(500).json({ success: false, message: 'ዳታ ማምጣት አልተቻለም' });
    }
};

module.exports = { getFixtures };