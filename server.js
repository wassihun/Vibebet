const express = require('express');
const cors = require('cors');
require('dotenv').config();

// 1. መጀመሪያ አፑ ይፈጠራል
const app = express();

// 2. ሚድልዌሮች (Middlewares)
app.use(cors()); // ከፍሮንትኤንድ (React/Next.js) የሚመጣ ጥያቄን ለመቀበል
app.use(express.json()); // ዳታን በ JSON ፎርማት ለመለዋወጥ

// 3. የራውት (Routes) ፋይሎችን ማገናኘት
const authRoutes = require('./routes/authRoutes');
const ticketRoutes = require('./routes/ticketRoutes');
const fixtureRoutes = require('./routes/fixtureRoutes');
const matchSyncRoutes = require('./routes/matchSync'); 

// 4. ዋና ዋና የኤፒአይ ማገናኛዎች (API Endpoints)
app.use('/api/auth', authRoutes);         // ለምዝገባ እና ሎጊን
app.use('/api/tickets', ticketRoutes);    // ለትኬት መቁረጫ፣ ቼክ እና ሪፖርት
app.use('/api/fixtures', fixtureRoutes);  // ለጨዋታዎች እና ኦዶች ማሳያ
app.use('/api/matches', matchSyncRoutes); // ለሲስተም ሴቲንግ እና ዳታ ማዘመኛ

// 🌟 5. ክሮን ጆቦችን ማስነሳት (Background Auto-Tasks) 🌟
// ይህ ኮድ ሰርቨሩ ሲበራ በየ 6 ሰዓቱ ጨዋታ እንዲያመጣ እና በየ 15 ደቂቃው ውጤት እንዲያጣራ ያደርጋል
const { startCronJobs } = require('./services/oddsService');
startCronJobs();

// 6. ፖርት ማዘጋጀት (Port Configuration)
const PORT = process.env.PORT || 5000;

// 7. ሰርቨሩን ማስነሳት
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`✅ የ AFRO BET ሰርቨር በፖርት ${PORT} ላይ በትክክል እየሰራ ነው...`);
    console.log(`=========================================`);
});