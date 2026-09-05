const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    
    // 1. ቶከን ከሌለ ቀጥታ መከልከል (ምክንያቱም ይህ ሚድልዌር ጥብቅ ለሆኑ የካሼር/አድሚን ራውቶች ብቻ ነው የሚያገለግለው)
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'ያልተፈቀደ: ቶከን አልተገኘም!' });
    }

    const token = authHeader.split(" ")[1];
    
    try {
        // 2. ቶከኑን ማረጋገጥ (የ .env ሴክሬት ኮድ ከሌለ ዲፎልት ይጠቀማል)
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_betting_key_2026');
        req.user = decoded; 
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'ቶከኑ ትክክል አይደለም ወይም ጊዜው አልፏል!' });
    }
};

// 3. 🌟 ትልቁ ማስተካከያ (ለ MVC አወቃቀር እንዲመች) 🌟
module.exports = { verifyToken };