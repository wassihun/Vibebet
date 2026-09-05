const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function createStaffAccounts() {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'betting_db'
        });

        console.log("ከ ዳታቤዝ ጋር ተገናኝቷል... ⏳");

        const saltRounds = 10;

        // 1. የአድሚን አካውንት መፍጠሪያ
        const adminPassword = await bcrypt.hash('admin123', saltRounds);
        await connection.query(
            `INSERT IGNORE INTO users (username, password_hash, role, status) VALUES (?, ?, 'admin', 'active')`,
            ['admin', adminPassword]
        );
        console.log("✅ አድሚን ተፈጥሯል -> Username: admin | Password: admin123");

        // 2. የካሼር አካውንት መፍጠሪያ
        const cashierPassword = await bcrypt.hash('cashier123', saltRounds);
        await connection.query(
            `INSERT IGNORE INTO users (username, password_hash, role, status) VALUES (?, ?, 'cashier', 'active')`,
            ['cashier', cashierPassword]
        );
        console.log("✅ ካሼር ተፈጥሯል -> Username: cashier | Password: cashier123");

        console.log("🎉 የሰራተኞች አካውንት በተሳካ ሁኔታ ተፈጥሯል! አሁን ሎጊን ማድረግ ይችላሉ።");
        process.exit(0);

    } catch (error) {
        console.error("❌ ስህተት ተፈጥሯል:", error.message);
        process.exit(1);
    }
}

createStaffAccounts();