const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');

// Telegram HMAC Hash Verification Helper
function verifyTelegramData(telegramInitData, botToken) {
  const urlParams = new URLSearchParams(telegramInitData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return { 
    isValid: calculatedHash === hash, 
    userData: JSON.parse(urlParams.get('user') || '{}') 
  };
}

// Render Login Page
router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Telegram Authentication & Registration API
router.post('/api/auth/telegram', async (req, res) => {
    const { initData } = req.body;
    if (!initData) {
      return res.status(400).json({ success: false, message: 'Missing Telegram authentication data.' });
    }

    const { isValid, userData } = verifyTelegramData(initData, process.env.TELEGRAM_BOT_TOKEN);
    
    if (!isValid || !userData.id) {
      return res.status(403).json({ success: false, message: 'Authentication failed: Invalid or forged session.' });
    }

    // Find existing user or create a new user profile
    let user = await User.findOne({ telegramId: userData.id.toString() });
    if (!user) {
      user = await User.create({
        telegramId: userData.id.toString(),
        username: userData.username || `${userData.first_name || 'Player'}_${userData.id}`
      });
    }

    req.session.user=user;
    await req.session.save();

    return res.json({ success: true, redirectTo: '/dashboard' });
  });

module.exports = router;