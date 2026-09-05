const mysql = require('mysql2/promise');
require('dotenv').config();

async function setupDatabase() {
    try {
        // 1. መጀመሪያ ከ MySQL ጋር ብቻ እንገናኛለን (ዳታቤዝ ሳንመርጥ)
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || ''
        });

        console.log("ከ MySQL ጋር ተገናኝቷል... ⏳");

        // 2. ዳታቤዙ ከሌለ እንፈጥረዋለን
        const dbName = process.env.DB_NAME || 'betting_db';
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbName}`);
        console.log(`ዳታቤዝ '${dbName}' ተፈጥሯል (ወይም ቀድሞውኑ አለ) ✅`);

        // 3. የተፈጠረውን ዳታቤዝ እንጠቀማለን
        await connection.query(`USE ${dbName}`);

        // ⚠️ አላስፈላጊ ስህተት እንዳይፈጠር የድሮ ቴብሎችን እናጠፋለን (Reset) ⚠️
        console.log("የድሮ ቴብሎችን በማጽዳት ላይ... ⏳");
        await connection.query('SET FOREIGN_KEY_CHECKS = 0');
        await connection.query('DROP TABLE IF EXISTS ticket_items, tickets, odds, fixtures, transactions, users, saved_matches, system_settings');
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');

        // 4. የተጠቃሚዎች ሰንጠረዥ (Users)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NULL,
                phone_number VARCHAR(15) UNIQUE NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'user',
                current_balance DECIMAL(10, 2) DEFAULT 0.00,
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Users ቴብል ተፈጥሯል ✅");

        // 5. የሲስተም ሴቲንጎች (System Settings) - በምስሉ ላይ የነበረ
        await connection.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                setting_key VARCHAR(100) UNIQUE NOT NULL,
                setting_value VARCHAR(255) NOT NULL
            )
        `);
        await connection.query(`INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES ('odds_api_key', 'YOUR_ODDS_API_KEY_HERE')`);
        console.log("System_settings ቴብል ተፈጥሯል ✅");

        // 6. የድሮው የጨዋታዎች ሰንጠረዥ (Fixtures) - በምስሉ ላይ የነበረ
        await connection.query(`
            CREATE TABLE IF NOT EXISTS fixtures (
                id VARCHAR(50) PRIMARY KEY,
                sport_key VARCHAR(100),
                home_team VARCHAR(100),
                away_team VARCHAR(100),
                commence_time DATETIME,
                status VARCHAR(50) DEFAULT 'unplayed'
            )
        `);
        console.log("Fixtures ቴብል ተፈጥሯል ✅");

        // 7. የድሮው የኦድ ሰንጠረዥ (Odds) - በምስሉ ላይ የነበረ
        await connection.query(`
            CREATE TABLE IF NOT EXISTS odds (
                id INT AUTO_INCREMENT PRIMARY KEY,
                fixture_id VARCHAR(50),
                odd_name VARCHAR(100),
                odd_value DECIMAL(10, 2),
                FOREIGN KEY (fixture_id) REFERENCES fixtures(id) ON DELETE CASCADE
            )
        `);
        console.log("Odds ቴብል ተፈጥሯል ✅");

        // 8. ከ API የሚመጡ ጨዋታዎች ማስቀመጫ (Saved Matches) - ለአዲሱ አሰራር የተስተካከለ
        await connection.query(`
            CREATE TABLE IF NOT EXISTS saved_matches (
                id VARCHAR(50) PRIMARY KEY,
                sport_key VARCHAR(100),
                home_team VARCHAR(100),
                away_team VARCHAR(100),
                commence_time DATETIME DEFAULT NULL,
                odds_data LONGTEXT
            )
        `);
        console.log("Saved_Matches ቴብል ተፈጥሯል ✅");

        // 9. የትራንዛክሽን ሰንጠረዥ (Transactions) - በምስሉ ላይ የነበረ
        await connection.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                amount DECIMAL(10, 2) NOT NULL,
                transaction_type VARCHAR(50),
                reference_id VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        console.log("Transactions ቴብል ተፈጥሯል ✅");

        // 10. የትኬት ዋና ሰንጠረዥ (Tickets)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                ticket_number VARCHAR(20) UNIQUE NULL,
                booking_code VARCHAR(20) UNIQUE NULL,
                stake_amount DECIMAL(10, 2) NOT NULL,
                total_odds DECIMAL(10, 2) NOT NULL,
                potential_win DECIMAL(10, 2) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            )
        `);
        console.log("Tickets ቴብል ተፈጥሯል ✅");

        // 11. የትኬት ዝርዝር ሰንጠረዥ (Ticket Items)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS ticket_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_id INT NOT NULL,
                fixture_id VARCHAR(50) NOT NULL,
                odd_id VARCHAR(50) NOT NULL,
                odd_value DECIMAL(10, 2) NOT NULL,
                match_info VARCHAR(255) NOT NULL,
                odd_name VARCHAR(100) NOT NULL,
                match_status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
            )
        `);
        console.log("Ticket_items ቴብል ተፈጥሯል ✅");

        console.log("🎉 ሁሉም 8 ዳታቤዝ ቴብሎች (በምስሉ መሰረት) በጥራት ተፈጥረዋል!");
        process.exit(0);

    } catch (error) {
        console.error("❌ ስህተት ተፈጥሯል:", error);
        process.exit(1);
    }
}

setupDatabase();