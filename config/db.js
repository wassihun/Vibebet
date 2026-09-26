const mysql = require('mysql2/promise'); 

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vibebet',
    port: process.env.DB_PORT || 3306, // 🌟 አዲስ: ፖርት ተጨምሯል
    waitForConnections: true,
    connectionLimit: 10, 
    queueLimit: 0,
    connectTimeout: 20000 // 🌟 አዲስ: ኤረር ከማምጣቱ በፊት 20 ሴኮንድ እንዲጠብቅ ተደርጓል
});

console.log('MySQL Connection Pool Created successfully.');

module.exports = pool;
