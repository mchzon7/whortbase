const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  name: { type: String, required: false },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  pointsBalance: { type: Number, default: 0 },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  bankDetails: {
    accountNumber: { type: String, default: '' },
    bankCode: { type: String, default: '' },
    accountName: { type: String, default: '' }
  },
  faucetPayAddress: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);