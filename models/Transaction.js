const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['deposit', 'withdrawal', 'game_stake', 'game_win', 'system_rake'], required: true },
  amount: { type: Number, required: true },
  channel: { type: String, enum: ['paystack', 'faucetpay', 'opay', 'system'], default: 'system' },
  reference: { type: String, unique: true, required: true },
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);