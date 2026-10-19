const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured in environment variables');
}

// ቶከን ማረጋገጫ (Verify Token)
const verifyToken = (req, res, next) => {
    // 🌟 ማስተካከያ: 'authorization' ወይም 'Authorization' በካፒታልም ቢመጣ እንዲቀበለው ተደርጓል
    const authHeader = req.headers.authorization || req.headers.Authorization;

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
        const decoded = jwt.verify(token, JWT_SECRET);

        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'ቶከኑ ትክክል አይደለም ወይም ጊዜው አልፏል!'
        });
    }
};

// 🌟 አዲስ የተጨመረ: አማራጭ ቶከን ማረጋገጫ (Optional Token Verify) 🌟
// (ሎጊን ያደረጉ ተጫዋቾችን እና ሎጊን ሳያደርጉ Guest ሆነው የሚቆርጡትን ለይቶ ለማሳለፍ)
const optionalVerifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        if (token) {
            try {
                req.user = jwt.verify(token, JWT_SECRET);
            } catch (error) {
                // ቶከኑ ቢበላሽም እንደ Guest ሆኖ እንዲያልፍ ዝም እንለዋለን
            }
        }
    }
    next();
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
    optionalVerifyToken, // 🌟 አዲሱ ፈንክሽን እዚህ ጋር ኤክስፖርት ተደርጓል
    isAdmin,
    isStaff
};