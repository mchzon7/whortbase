const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  pointsBalance: { type: Number, default: 1000 }, // Default welcome bonus points
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);