require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');

const User = require('./models/User');
const Transaction = require('./models/Transaction');
const GameSession = require('./models/GameSession');
const WhotEngine = require('./engine/WhotEngine');

const paystackCtrl = require('./controllers/paystack');
const faucetpayCtrl = require('./controllers/faucetpay');
const opayCtrl = require('./controllers/opay');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware Setup
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
});
app.use(sessionMiddleware);

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI).then(() => console.log('MongoDB Connected'));

// Auth Middleware
const authGuard = async (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id);
    if (!req.user) return res.redirect('/login');
    next();
  } catch (err) {
    res.redirect('/login');
  }
};

const adminGuard = (req, res, next) => {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).send('Forbidden');
};

// Helper: Cryptographically verify Telegram initData
function parseAndVerifyTelegramData(initData, botToken) {
  if (!initData) return null;

  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  // Sort remaining parameters alphabetically
  const dataCheckString = Array.from(urlParams.entries())
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  // Calculate HMAC-SHA256 signature
  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculatedHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (calculatedHash !== hash) return null;

  // Extract parsed user object
  const userParam = urlParams.get('user');
  return userParam ? JSON.parse(userParam) : null;
}

// Route: Handle Auto-Signup & Login from Telegram Bot
app.post('/auth/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    const tgUser = parseAndVerifyTelegramData(initData, process.env.TELEGRAM_BOT_TOKEN);

    if (!tgUser) {
      return res.status(401).json({ success: false, message: 'Invalid Telegram data' });
    }

    // Auto-Signup / Find existing user by telegramId
    let user = await User.findOne({ telegramId: tgUser.id.toString() });

    if (!user) {
      user = await User.create({
        telegramId: tgUser.id.toString(),
        username: tgUser.username || `user_${tgUser.id}`,
        firstName: tgUser.first_name || 'Player',
        pointsBalance: 1000 // Welcome bonus
      });
    } else if (tgUser.username && user.username !== tgUser.username) {
      // Sync username if changed
      user.username = tgUser.username;
      await user.save();
    }

    // Set Express Session
    req.session.userId = user._id;

    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server authentication error' });
  }
});

// HTTP Routes
app.get('/', (req, res) => res.redirect('/dashboard', { error: null }));
app.get('/login', (req, res) => res.render('login', { error: null }));
app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, email, password: hashedPassword });
    res.redirect('/login');
  } catch (err) {
    res.render('register', { error: 'Username or Email already exists' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (user && await bcrypt.compare(password, user.password)) {
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.cookie('token', token, { httpOnly: true });
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Invalid Credentials' });
  }
});

// DELETE Route: Remove Host Room & Cleanup
app.delete('/api/rooms/delete/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;

    // 1. Find the host room session in database
    const session = await GameSession.findOne({ roomId });
    if (!session) {
      return res.status(404).json({ success: false, message: 'Host room not found.' });
    }

    // 2. Refund points to any joined players if the game hasn't finished
    if (session.status === 'waiting' && session.players.length > 0) {
      for (const userId of session.players) {
        await User.findByIdAndUpdate(userId, {
          $inc: { pointsBalance: session.stake }
        });
      }
    }

    // 3. Remove active memory session if running
    if (activeGames[roomId]) {
      io.to(roomId).emit('playerForfeited', { 
        message: 'This host room was deleted by the host/admin.' 
      });
      delete activeGames[roomId];
    }

    // 4. Delete room session from MongoDB
    await GameSession.deleteOne({ roomId });

    return res.json({ success: true, message: 'Host deleted successfully.' });
  } catch (err) {
    console.error('Error deleting host room:', err);
    return res.status(500).json({ success: false, message: 'Server error during deletion.' });
  }
});

app.get('/dashboard', authGuard, async (req, res) => {
  const rooms = await GameSession.find({ status: 'waiting' }).populate('host', 'username');
  res.render('dashboard', { user: req.user, rooms });
});

app.get('/wallet', authGuard, (req, res) => res.render('wallet', { user: req.user }));
// Add payment callback verification route
app.get('/wallet/verify', authGuard, paystackCtrl.verifyDeposit);

app.get('/admin', authGuard, adminGuard, async (req, res) => {
  const users = await User.find();
  const txns = await Transaction.find().populate('user', 'username');
  const totalRake = await GameSession.aggregate([{ $group: { _id: null, total: { $sum: "$houseRakeGenerated" } } }]);
  res.render('admin', { users, txns, houseRevenue: totalRake[0]?.total || 0 });
});

app.get('/game/:roomId', authGuard, async (req, res) => {
  const room = await GameSession.findOne({ roomId: req.params.roomId });
  if (!room) return res.redirect('/dashboard');
  res.render('game', { user: req.user, roomId: req.params.roomId });
});

// API Endpoints for Wallet Operations
app.post('/api/deposit/paystack', authGuard, paystackCtrl.initializeDeposit);
app.post('/api/webhook/paystack', paystackCtrl.webhook);
app.post('/api/withdraw/faucetpay', authGuard, faucetpayCtrl.withdrawCrypto);
app.post('/api/withdraw/opay', authGuard, opayCtrl.withdrawBank);

// Socket.io Real-Time Game Mechanics & Engine State Manager
const activeGames = {}; // In-memory runtime state
  // In-memory mapping to support page refreshes/reconnections
const userSockets = {}; // userId -> socketId

io.on('connection', (socket) => {
  socket.on('joinLobbyChat', () => socket.join('lobby'));
  socket.on('sendLobbyMsg', (data) => io.to('lobby').emit('receiveLobbyMsg', data));

  socket.on('createRoom', async ({ userId, stake, maxPlayers }) => {
    const user = await User.findById(userId);
    if (user.pointsBalance < stake) {
      return socket.emit('errorMsg', 'Insufficient points balance to host this room.');
    }
     // Key: "roomId_userId" -> Timeout Handle
    const roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
    const session = await GameSession.create({
      roomId,
      stake,
      maxPlayers,
      host: userId,
      players: [userId]
    });
    user.pointsBalance -= stake;
    await user.save();
    socket.emit('roomCreated', roomId);
  });

  socket.on('joinRoom', async ({ roomId, userId }) => {
  userSockets[userId] = socket.id;
  socket.join(roomId);

  let gameState = activeGames[roomId];
  const disconnectTimers = {};

  // If rejoining an active game, clear any disconnect timer
  if (gameState) {
    const timerKey = `${roomId}_${userId}`;
    if (disconnectTimers[timerKey]) {
      clearTimeout(disconnectTimers[timerKey]);
      delete disconnectTimers[timerKey];
    }
    
    // Safely emit game state without non-serializable objects
    socket.emit('gameStateUpdate', gameState);
    return;
  }

  // Normal room join logic
  const session = await GameSession.findOne({ roomId, status: 'waiting' });
  const user = await User.findById(userId);
  if (!session) return socket.emit('errorMsg', 'Room unavailable.');
  if (user.pointsBalance < session.stake) return socket.emit('errorMsg', 'Insufficient points.');

  if (!session.players.includes(userId)) {
    session.players.push(userId);
    user.pointsBalance -= session.stake;
    await user.save();
    await session.save();
  }

  if (session.players.length === session.maxPlayers) {
    session.status = 'active';
    await session.save();

    const deck = WhotEngine.generateDeck();
    const hands = {};
    session.players.forEach(pId => {
      hands[pId.toString()] = deck.splice(0, 6);
    });

    // Clean activeGames object without timer handles inside it
    activeGames[roomId] = {
      deck,
      hands,
      topCard: deck.pop(),
      players: session.players.map(p => p.toString()),
      turnIndex: 0,
      requestedShape: null,
      pendingDraw: 0,
      stake: session.stake,
      maxPlayers: session.maxPlayers
    };

    io.to(roomId).emit('gameStarted', activeGames[roomId]);
  }
});

  // --- REFRESH-SAFE DISCONNECT HANDLER ---
  

  // ... Keep playCard, drawCard, and sendGameMsg handlers as they were


  // Replace the socket.on('playCard') block in server.js with this logic:

socket.on('playCard', async ({ roomId, userId, cardIndex, requestedShape }) => {
  const gameState = activeGames[roomId];
  if (!gameState) return;
  const currentPlayerId = gameState.players[gameState.turnIndex];
  if (currentPlayerId !== userId) return socket.emit('errorMsg', "Not your turn!");

  const playerHand = gameState.hands[userId];
  const playedCard = playerHand[cardIndex];

  if (!WhotEngine.validateMove(playedCard, gameState.topCard, gameState.requestedShape)) {
    return socket.emit('errorMsg', "Invalid card move!");
  }

  // Execute Move
  playerHand.splice(cardIndex, 1);
  gameState.topCard = playedCard;
  gameState.requestedShape = playedCard.number === 20 ? requestedShape : null;

  // Replace win check inside socket.on('playCard'):
  if (playerHand.length === 0) {
    return handleRoundEnd(roomId, userId);
  }

  let advanceTurn = 1;

  if (playedCard.number === 1) {
    // Hold On: Active player continues
    advanceTurn = 0; 
  } else if (playedCard.number === 2) {
    // Pick Two: Opponent draws 2, active player continues
    const nextPlayerIndex = (gameState.turnIndex + 1) % gameState.players.length;
    const nextPlayerId = gameState.players[nextPlayerIndex];
    for (let i = 0; i < 2; i++) {
      if (gameState.deck.length > 0) gameState.hands[nextPlayerId].push(gameState.deck.pop());
    }
    advanceTurn = 0;
  } else if (playedCard.number === 5) {
    // Pick Three: Opponent draws 3, active player continues
    const nextPlayerIndex = (gameState.turnIndex + 1) % gameState.players.length;
    const nextPlayerId = gameState.players[nextPlayerIndex];
    for (let i = 0; i < 3; i++) {
      if (gameState.deck.length > 0) gameState.hands[nextPlayerId].push(gameState.deck.pop());
    }
    advanceTurn = 0;
  } else if (playedCard.number === 8) {
    advanceTurn = 2; // Suspension
  } else if (playedCard.number === 14) {
    gameState.players.forEach(p => {
      if (p !== userId && gameState.deck.length > 0) gameState.hands[p].push(gameState.deck.pop());
    });
  }

  gameState.turnIndex = (gameState.turnIndex + advanceTurn) % gameState.players.length;
  io.to(roomId).emit('gameStateUpdate', gameState);
});

  socket.on('drawCard', ({ roomId, userId }) => {
    const gameState = activeGames[roomId];
    if (!gameState) return;
    if (gameState.players[gameState.turnIndex] !== userId) return;

    const cardsToDrawCount = gameState.pendingDraw > 0 ? gameState.pendingDraw : 1;
    for (let i = 0; i < cardsToDrawCount; i++) {
      if (gameState.deck.length > 0) {
        gameState.hands[userId].push(gameState.deck.pop());
      }
    }
    gameState.pendingDraw = 0;
    gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
    io.to(roomId).emit('gameStateUpdate', gameState);
  });

  socket.on('sendGameMsg', ({ roomId, username, message }) => {
    io.to(roomId).emit('receiveGameMsg', { username, message });
  });

  // Add this inside the io.on('connection', (socket) => { ... }) block in server.js

socket.on('leaveRoom', async ({ roomId, userId }) => {
  const gameState = activeGames[roomId];
  
  if (gameState) {
    // Identify the remaining player(s)
    const remainingPlayers = gameState.players.filter(id => id !== userId);
    
    // If a game is active with 2 players, award victory to the opponent
    if (remainingPlayers.length === 1) {
      const winnerId = remainingPlayers[0];
      
      // Resolve payouts for the forfeit
      await resolveGameVictory(roomId, winnerId);
      
      // Notify the remaining player
      io.to(roomId).emit('playerForfeited', { 
        message: 'Your opponent left the game. You win by forfeit!' 
      });
    } else {
      // For multi-player matches, notify remaining room members
      io.to(roomId).emit('playerForfeited', { 
        message: 'A player has quit the room.' 
      });
      delete activeGames[roomId];
    }

    // Leave the Socket.io room
    socket.leave(roomId);
  }
  });

  socket.on('disconnecting', () => {
  const userId = Object.keys(userSockets).find(key => userSockets[key] === socket.id);
  const disconnectTimers = {};

  if (userId) {
    delete userSockets[userId];

    for (const roomId of socket.rooms) {
      if (activeGames[roomId]) {
        const timerKey = `${roomId}_${userId}`;
        disconnectTimers[timerKey] = setTimeout(async () => {
          io.to(roomId).emit('playerForfeited', { 
            message: 'Opponent failed to reconnect. Match ended.' 
          });
          delete activeGames[roomId];
          delete disconnectTimers[timerKey];
        }, 1000000);
      }
    }
  }
  });
});

// Utility to score remaining hand values
// Calculate total card value remaining in a player's hand
function calculateHandScore(hand) {
  return hand.reduce((total, card) => {
    // Star cards count as double face value in Whot
    if (card.shape === 'Star') {
      return total + (card.number * 2);
    }
    return total + card.number;
  }, 0);
}

// Handles knockout logic when a player empties their hand
async function handleRoundEnd(roomId, roundWinnerId) {
  const gameState = activeGames[roomId];
  if (!gameState) return;

  const scores = {};
  let highestScore = -1;
  let playerToEliminate = null;

  // Calculate remaining points for all non-winners
  gameState.players.forEach(pId => {
    if (pId !== roundWinnerId) {
      const score = calculateHandScore(gameState.hands[pId] || []);
      scores[pId] = score;

      if (score > highestScore) {
        highestScore = score;
        playerToEliminate = pId;
      }
    } else {
      scores[pId] = 0; // Round winner has 0 points
    }
  });

  // Eliminate player with highest card score
  gameState.players = gameState.players.filter(id => id !== playerToEliminate);

  // Notify all room members of round scores and elimination
  io.to(roomId).emit('roundEnded', {
    roundWinnerId,
    scores,
    eliminatedPlayerId: playerToEliminate,
    remainingPlayersCount: gameState.players.length
  });

  // Check if only 1 player remains (Ultimate Tournament Winner)
  if (gameState.players.length === 1) {
    const ultimateWinnerId = gameState.players[0];
    await resolveGameVictory(roomId, ultimateWinnerId);
  } else {
    // Wait 4 seconds, then start next round with remaining players
    setTimeout(() => {
      startNextRound(roomId);
    }, 4000);
  }
}

// Resets hands and deck for the remaining tournament players
function startNextRound(roomId) {
  const gameState = activeGames[roomId];
  if (!gameState) return;

  const deck = WhotEngine.generateDeck();
  const hands = {};

  gameState.players.forEach(pId => {
    hands[pId] = deck.splice(0, 6);
  });

  gameState.deck = deck;
  gameState.hands = hands;
  gameState.topCard = deck.pop();
  gameState.turnIndex = 0;
  gameState.requestedShape = null;
  gameState.pendingDraw = 0;

  io.to(roomId).emit('gameStateUpdate', gameState);
}

// Function to handle match payouts and game completion
// Function to resolve 4-player tournament victory with 70/30 commission split
async function resolveGameVictory(roomId, ultimateWinnerId) {
  const gameState = activeGames[roomId];
  if (!gameState) return;

  try {
    // 1. Calculate total stake pool (Stake per player * Max initial players)
    const totalPot = gameState.stake * gameState.maxPlayers; // e.g., 100 * 4 = 400 points

    // 2. Calculate 70/30 pot distribution
    const ownerCommission = totalPot * 0.20; // 20% site owner share (120 points)
    const winnerPayout = totalPot * 0.80;    // 80% winner share (280 points)

    // 3. Credit the ultimate winner with 70% of the pot
    await User.findByIdAndUpdate(ultimateWinnerId, {
      $inc: { pointsBalance: winnerPayout }
    });

    // 4. Record platform earnings (Optional: create a commission transaction log)
    if (typeof PlatformEarning !== 'undefined') {
      await PlatformEarning.create({
        roomId,
        totalPot,
        ownerShare: ownerCommission,
        winnerShare: winnerPayout,
        winnerId: ultimateWinnerId,
        createdAt: new Date()
      });
    }

    // 5. Mark the game session as completed in database
    await GameSession.findOneAndUpdate(
      { roomId },
      { 
        status: 'completed', 
        winner: ultimateWinnerId,
        ownerCommission: ownerCommission,
        winnerPayout: winnerPayout
      }
    );

    // 6. Broadcast game over to all clients in the room
    io.to(roomId).emit('gameOver', { 
      winnerId: ultimateWinnerId, 
      winnerPayout,
      ownerCommission,
      totalPot 
    });

    // 7. Clean up memory
    delete activeGames[roomId];
  } catch (err) {
    console.error("Error resolving game victory split:", err);
  }
}

server.listen(process.env.PORT || 3000, () => console.log('Server running on port 3000'));