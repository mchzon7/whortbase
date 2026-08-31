const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  pointsBalance: { type: Number, default: 0 },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  
  // Referral Fields
  referralCode: { type: String, unique: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  hasEarnedReferralReward: { type: Boolean, default: false } // Ensures reward is awarded once
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);