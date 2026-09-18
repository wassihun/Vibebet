const mysql = require('mysql2/promise'); // 🔑 በቀጥታ Promise-based የሆነውን እናመጣለን

// 🔑 createConnection የነበረውን ወደ createPool ቀይረነዋል
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vibebet',
    waitForConnections: true,
    connectionLimit: 10, // በአንድ ጊዜ እስከ 10 ኮኔክሽኖችን ያስተናግዳል
    queueLimit: 0
});

console.log('MySQL Connection Pool Created successfully.');

// 🔑 Pool ራሱ ቀጥታ db.query ማድረግንም ሆነ db.getConnection መውሰድን ይደግፋል
module.exports = pool;