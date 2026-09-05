const mysql = require('mysql2/promise');
require('dotenv').config();

async function seedData() {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        });

        console.log("ለቴስት የሚሆን ዳታ በማስገባት ላይ... ⏳");

        // 1. ሁለት የእግርኳስ ጨዋታዎችን ማስገባት
        await connection.execute(`
            INSERT IGNORE INTO fixtures (id, home_team, away_team, match_time, status) VALUES 
            (1, 'Arsenal', 'Chelsea', '2026-09-01 18:00:00', 'upcoming'),
            (2, 'Man City', 'Liverpool', '2026-09-02 19:00:00', 'upcoming')
        `);

        // 2. ለጨዋታዎቹ ኦዶችን ማስገባት
        await connection.execute(`
            INSERT IGNORE INTO odds (id, fixture_id, market_name, option_name, odd_value) VALUES 
            (101, 1, '1X2', 'Home', 2.50),
            (102, 2, '1X2', 'Away', 1.80)
        `);

        console.log("✅ ዳታው በተሳካ ሁኔታ ገብቷል! አሁን ፖስትማንን መሞከር ትችላለህ።");
        process.exit(0);

    } catch (error) {
        console.error("❌ ስህተት:", error);
        process.exit(1);
    }
}

seedData();