const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'ያልተፈቀደ: ቶከን አልተገኘም!' });
    }

    const token = authHeader.split(" ")[1];
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_betting_key_2026');
        req.user = decoded; 
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'ቶከኑ ትክክል አይደለም ወይም ጊዜው አልፏል!' });
    }
};

// 🔒 SECURITY: የአድሚንነት ማረጋገጫ (Authorization)
const isAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'ይህንን ተግባር መፈጸም የሚችለው አድሚን ብቻ ነው! (Forbidden)' });
    }
    next();
};

module.exports = { verifyToken, isAdmin };