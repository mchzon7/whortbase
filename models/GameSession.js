const mongoose = require('mongoose');

const gameSessionSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  stake: { type: Number, required: true },
  maxPlayers: { type: Number, required: true },
  host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['waiting', 'active', 'completed'], default: 'waiting' },
  winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  houseRakeGenerated: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('GameSession', gameSessionSchema);