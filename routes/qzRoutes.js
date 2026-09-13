const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Root ፎልደር ላይ ያለውን private-key.pem እናነባለን
const privateKeyPath = path.join(__dirname, '../private-key.pem');
const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

// POST /api/qz/sign
router.post('/sign', (req, res) => {
    try {
        const { request } = req.body; 
        
        const sign = crypto.createSign('SHA512');
        sign.update(request);
        const signature = sign.sign(privateKey, 'base64');
        
        res.status(200).send(signature);
    } catch (error) {
        console.error("QZ Signing Error:", error);
        res.status(500).send('Signing error');
    }
});

module.exports = router;