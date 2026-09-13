const mysql = require('mysql2'); // ይህ መስመር መኖር አለበት!

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vibebet',
    port: process.env.DB_PORT || 3306
});

// ዳታቤዝ ማገናኘቱን ማረጋገጫ (ከተቻለ)
db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err.stack);
        return;
    }
    console.log('Connected to MySQL database as id ' + db.threadId);
});

module.exports = db;
