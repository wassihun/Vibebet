const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet'); // 🌟 አዲስ የተጨመረ: ለ HTTP ደህንነት 🌟

// 1. መጀመሪያ አፑ ይፈጠራል
const app = express();

// 🌟 ወሳኝ: ሰርቨርህ ከ Cloudflare, cPanel ወይም Vercel ጀርባ ከሆነ Rate Limiter በትክክል እንዲሰራ ይህ ግዴታ ነው 🌟
app.set('trust proxy', 1);

// 2. ሚድልዌሮች (Middlewares)
app.use(helmet()); // 🔒 የ Express ሰርቨር መሆኑን ይደብቃል፣ ከ XSS እና Clickjacking ይጠብቃል

const corsOptions = {
    origin: function (origin, callback) {
        const allowedOrigins = [
            'https://vibebet.et', 
            'https://www.vibebet.et',
            'http://localhost:5173',
            'http://localhost:3000',
            // 🔒 SECURITY FIX: ማንኛውንም Vercel ከመፍቀድ፣ ትክክለኛውን የ Vercel ሊንክህን ብቻ እዚህ አስገባ
            // 'https://your-exact-project-name.vercel.app' 
        ];
        
        // በ Production ጊዜ origin null እንዲሆን አትፍቀድ (ከ Postman እና ከሌሎች የሚመጡ ጥያቄዎችን ይከለክላል)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true // ሎጊን ሲደረግ ቶከን እንዲያሳልፍ
};

app.use(cors(corsOptions)); 
app.use(express.json()); // ዳታን በ JSON ፎርማት ለመለዋወጥ

// ==========================================================
// 🔒 SECURITY: የሲስተም መጨናነቅ መከላከያ (Global Rate Limiter)
// ==========================================================
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 ደቂቃ (Time window)
    max: 120, // አንድ IP Address በ1 ደቂቃ ውስጥ ከ 120 ጥያቄ በላይ መላክ አይችልም
    message: { success: false, message: 'በጣም ብዙ ጥያቄዎች ተልከዋል! እባክዎ ከ1 ደቂቃ በኋላ እንደገና ይሞክሩ።' },
    standardHeaders: true, 
    legacyHeaders: false,
});
app.use(limiter); // ይህ ህግ በሁሉም የ API ጥያቄዎች ላይ ይሰራል

// 🔒 SECURITY: ለ ሎጊን እና ምዝገባ ብቻ የሚሰራ (ጥብቅ የሆነ)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 ደቂቃ
    max: 10, // በ15 ደቂቃ ውስጥ ከ10 ጊዜ በላይ ሎጊን መሞከር አይቻልም (Brute-force attack ይከላከላል)
    message: { success: false, message: 'በጣም ብዙ የሎጊን ሙከራዎች! እባክዎ ከ15 ደቂቃ በኋላ እንደገና ይሞክሩ።' }
});
app.use('/api/auth/login', authLimiter); // ሎጊን ላይ ብቻ ይተገበራል
// ==========================================================

// 3. የራውት (Routes) ፋይሎችን ማገናኘት
const authRoutes = require('./routes/authRoutes');
const ticketRoutes = require('./routes/ticketRoutes');
const fixtureRoutes = require('./routes/fixtureRoutes');
const matchSyncRoutes = require('./routes/matchSync'); 
const qzRoutes = require('./routes/qzRoutes');

// 4. ዋና ዋና የኤፒአይ ማገናኛዎች (API Endpoints)
app.use('/api/auth', authRoutes);         // ለምዝገባ እና ሎጊን
app.use('/api/tickets', ticketRoutes);    // ለትኬት መቁረጫ፣ ቼክ እና ሪፖርት
app.use('/api/fixtures', fixtureRoutes);  // ለጨዋታዎች እና ኦዶች ማሳያ
app.use('/api/matches', matchSyncRoutes); // ለሲስተም ሴቲንግ እና ዳታ ማዘመኛ
app.use('/api/qz', qzRoutes);

// 🌟 5. ክሮን ጆቦችን ማስነሳት (Background Auto-Tasks) 🌟
const { startCronJobs } = require('./services/oddsService');
startCronJobs();

// 6. ፖርት ማዘጋጀት (Port Configuration)
const PORT = process.env.PORT || 5000;

// 7. ሰርቨሩን ማስነሳት
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`✅ የ Vibebet.et ሰርቨር በፖርት ${PORT} ላይ በትክክል እየሰራ ነው...`);
    console.log(`=========================================`);
});