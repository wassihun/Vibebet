const jwt = require('jsonwebtoken');

// ቶከን ማረጋገጫ (Verify Token)
const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'ያልተፈቀደ: ቶከን አልተገኘም!'
        });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'ቶከን አልተገኘም!'
        });
    }

    try {
        // .env ላይ JWT_SECRET ከሌለ Default ይጠቀማል
        const secret = process.env.JWT_SECRET || 'super_secret_betting_key_2026';
        const decoded = jwt.verify(token, secret);

        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'ቶከኑ ትክክል አይደለም ወይም ጊዜው አልፏል!'
        });
    }
};

// አድሚን መሆኑን ማረጋገጫ
const isAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({
            success: false,
            message: 'ይህንን ተግባር መፈጸም የሚችለው admin ብቻ ነው!'
        });
    }
    next();
};

// ሰራተኛ (ካሼር ወይም አድሚን) መሆኑን ማረጋገጫ
const isStaff = (req, res, next) => {
    if (!req.user || !['admin', 'cashier'].includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: 'ይህንን ተግባር የሚፈጽሙት cashier ወይም admin ብቻ ናቸው!'
        });
    }
    next();
};

// 🌟 ራውተሩ የሚፈልጋቸው ፈንክሽኖች ኤክስፖርት መደረጋቸውን እርግጠኛ ሁን!
module.exports = {
    verifyToken,
    isAdmin,
    isStaff
};