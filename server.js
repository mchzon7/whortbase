require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const User = require('./models/User');
const Transaction = require('./models/Transaction');
const GameSession = require('./models/GameSession');
const WhotEngine = require('./engine/WhotEngine');

const paystackCtrl = require('./controllers/paystack');
const faucetpayCtrl = require('./controllers/faucetpay');
const opayCtrl = require('./controllers/opay');
const binanceCtrl = require('./controllers/binance');
const timewallCtrl = require('./controllers/timewall');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware Setup
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Express Session Middleware setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_session_secret_key_123',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 1 day
    httpOnly: true,
    secure: false // Set to true in production if using HTTPS
  }
}));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI).then(() => console.log('MongoDB Connected'));

// --- TELEGRAM HMAC VERIFICATION HELPER ---
function verifyTelegramData(telegramInitData, botToken) {
  if (!botToken) throw new Error('BOT_TOKEN is missing in environment variables.');

  const urlParams = new URLSearchParams(telegramInitData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  let userData = {};
  try {
    userData = JSON.parse(urlParams.get('user') || '{}');
  } catch (e) {
    console.error('Error parsing Telegram user JSON:', e);
  }

  return { isValid: calculatedHash === hash, userData };
}

// Session Auth Guard Middleware
const authGuard = async (req, res, next) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  try {
    req.user = await User.findById(req.session.userId);
    if (!req.user) {
      req.session.destroy();
      return res.redirect('/login');
    }
    next();
  } catch (err) {
    req.session.destroy();
    return res.redirect('/login');
  }
};

const adminGuard = (req, res, next) => {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).send('Forbidden');
};

// --- AUTH ROUTES (TELEGRAM ONLY) ---
app.get('/', (req, res) => res.render('login', { error: null }));
app.get('/login', (req, res) => res.render('login', { error: null }));
app.get('/register', (req, res) => res.render('register', { error: null }));

// Telegram Auto Authentication Endpoint
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData, refCode } = req.body;
    if (!initData) {
      return res.status(400).json({ success: false, message: 'Missing initData.' });
    }

    const { isValid, userData } = verifyTelegramData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!isValid || !userData.id) {
      return res.status(403).json({ success: false, message: 'Invalid Telegram session.' });
    }

    let user = await User.findOne({ telegramId: userData.id.toString() });

    if (!user) {
      // Find the referrer if a valid code was provided
      let referrer = null;
      if (refCode) {
        referrer = await User.findOne({ referralCode: refCode.toUpperCase() });
      }

      // Generate a unique referral code for the new user
      const newRefCode = 'REF_' + crypto.randomBytes(3).toString('hex').toUpperCase();

      user = await User.create({
        telegramId: userData.id.toString(),
        username: userData.username || `${userData.first_name || 'Player'}_${userData.id}`,
        pointsBalance: 0,
        referralCode: newRefCode,
        referredBy: referrer ? referrer._id : null
      });
    }

    req.session.userId = user._id;
    return res.json({ success: true, redirectTo: '/dashboard' });
  } catch (err) {
    console.error('Auth Error:', err);
    return res.status(500).json({ success: false, message: 'Server auth error.' });
  }
});

// TIMEWALL
app.all(['/api/webhooks/timewall', '/postback/timewall'], timewallCtrl.handlePostback);
// Logout Route
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// DELETE Route: Remove Host Room & Cleanup
// DELETE/HIDE Route: Permanent for Host/Admin, Temporary (Hide) for Regular Users
app.delete('/api/rooms/delete/:roomId', authGuard, async (req, res) => {
  try {
    const { roomId } = req.params;
    const currentUserId = req.user._id;

    const session = await GameSession.findOne({ roomId });
    if (!session) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    const isHost = session.host.toString() === currentUserId.toString();
    const isAdmin = req.user.role === 'admin';

    // 1. PERMANENT DELETION (Only Creator or Admin)
    if (isHost || isAdmin) {
      // Refund players if the game is still waiting
      if (session.status === 'waiting' && session.players.length > 0) {
        for (const userId of session.players) {
          await User.findByIdAndUpdate(userId, {
            $inc: { pointsBalance: session.stake }
          });
        }
      }

      // If game is active, forfeit and cleanup
      if (activeGames[roomId]) {
        io.to(roomId).emit('playerForfeited', {
          message: 'This host room was deleted permanently by the host/admin.'
        });
        delete activeGames[roomId];
      }

      await GameSession.deleteOne({ roomId });

      // Notify ALL clients to remove room from lobby UI
      io.to('lobby').emit('roomDeleted', { roomId });

      return res.json({
        success: true,
        permanent: true,
        message: 'Host room permanently deleted and refunded.'
      });
    } 

    // 2. TEMPORARY DELETION (Regular User Hides Room for Themselves)
    else {
      // Add user to hiddenBy array if not already present
      if (!session.hiddenBy.includes(currentUserId)) {
        session.hiddenBy.push(currentUserId);
        await session.save();
      }

      return res.json({
        success: true,
        permanent: false,
        message: 'Room hidden from your lobby feed.'
      });
    }

  } catch (err) {
    console.error('Error handling room deletion:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Page Routes
app.get('/dashboard', authGuard, async (req, res) => {
  const rooms = await GameSession.find({ status: 'waiting' }).populate('host', 'username');
  res.render('dashboard', { user: req.user, rooms });
});

app.get('/wallet', authGuard, (req, res) => res.render('wallet', { user: req.user, procee: process.env.PAYSTACK_PUBLIC_KEY, timewallID: process.env.TIMEWALL_PUBLISHER_ID }));
app.get('/wallet/verify', authGuard, paystackCtrl.verifyDeposit);

app.get('/admin', authGuard, adminGuard, async (req, res) => {
  const users = await User.find();
  const txns = await Transaction.find().populate('user', 'username');
  const totalRake = await GameSession.aggregate([
    { $group: { _id: null, total: { $sum: '$houseRakeGenerated' } } }
  ]);
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
app.post('/api/withdraw/binance', authGuard, binanceCtrl.withdrawBinance);

// Socket.io Real-Time Game Mechanics & Engine State Manager
const activeGames = {}; // In-memory runtime state
const userSockets = {}; // userId -> socketId
const disconnectTimers = {}; // Key: "roomId_userId" -> Timeout Handle

io.on('connection', (socket) => {
  socket.on('joinLobbyChat', () => socket.join('lobby'));
  socket.on('sendLobbyMsg', (data) => io.to('lobby').emit('receiveLobbyMsg', data));

  socket.on('createRoom', async ({ userId, stake, maxPlayers }) => {
    const user = await User.findById(userId);
    if (!user || user.pointsBalance < stake) {
      return socket.emit('errorMsg', 'Insufficient points balance to host this room.');
    }

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
    io.to('lobby').emit('roomCreatedLobby', {
      roomId: session.roomId,
      hostName: user.username,
      stake: session.stake,
      maxPlayers: session.maxPlayers,
      currentPlayers: 1
    });
  });

  socket.on('joinRoom', async ({ roomId, userId }) => {
    userSockets[userId] = socket.id;
    socket.join(roomId);

    const timerKey = `${roomId}_${userId}`;
    if (disconnectTimers[timerKey]) {
      clearTimeout(disconnectTimers[timerKey]);
      delete disconnectTimers[timerKey];
      io.to(roomId).emit('playerReconnected', { userId });
    }

    let gameState = activeGames[roomId];
    if (gameState) {
      socket.emit('gameStateUpdate', gameState);
      return;
    }

    const session = await GameSession.findOne({ roomId, status: 'waiting' });
    const user = await User.findById(userId);

    if (!session) return socket.emit('errorMsg', 'Room unavailable.');
    if (user.pointsBalance < session.stake) return socket.emit('errorMsg', 'Insufficient points.');

    if (!session.players.includes(userId)) {
      session.players.push(userId);
      user.pointsBalance -= session.stake;
      await user.save();
      await session.save();

      io.to('lobby').emit('roomUpdatedLobby', {
        roomId,
        currentPlayers: session.players.length
      });

      if (session.players.length === session.maxPlayers) {
        session.status = 'active';
        await session.save();

        const deck = WhotEngine.generateDeck();
        const hands = {};
        session.players.forEach((pId) => {
          hands[pId.toString()] = deck.splice(0, 6);
        });

        activeGames[roomId] = {
          deck,
          hands,
          topCard: deck.pop(),
          players: session.players.map((p) => p.toString()),
          turnIndex: 0,
          requestedShape: null,
          pendingPick3Count: 0,
          pendingPick2Count: 0,
          stake: session.stake,
          maxPlayers: session.maxPlayers
        };

        io.to('lobby').emit('roomDeleted', { roomId });
        io.to(roomId).emit('gameStarted', activeGames[roomId]);
      }
    }
  });

  socket.on('playCard', async ({ roomId, userId, cardIndex, requestedShape }) => {
    const gameState = activeGames[roomId];
    if (!gameState) return;

    const currentPlayerId = gameState.players[gameState.turnIndex];
    if (currentPlayerId !== userId) return socket.emit('errorMsg', "Not your turn!");

    const playerHand = gameState.hands[userId];
    const playedCard = playerHand[cardIndex];

    if (gameState.pendingPick3Count > 0) {
      if (playedCard.number === 5) {
        gameState.pendingPick3Count = 0;
        playerHand.splice(cardIndex, 1);
        gameState.topCard = playedCard;
        gameState.lastPlayerId = userId;
        gameState.requestedShape = null;

        if (playerHand.length === 0) return handleRoundEnd(roomId, userId);

        if (gameState.pick3InitiatorId) {
          gameState.turnIndex = gameState.players.indexOf(gameState.pick3InitiatorId);
          gameState.pick3InitiatorId = null;
        } else {
          gameState.turnIndex = (gameState.turnIndex - 1 + gameState.players.length) % gameState.players.length;
        }

        io.to(roomId).emit('gameAlert', {
          message: `Pick 3 defended! Turn returns to play from current card shape.`
        });
        io.to(roomId).emit('gameStateUpdate', gameState);
        return;
      } else {
        return socket.emit('errorMsg', `You must defend with Pick 3 or draw ${gameState.pendingPick3Count * 3} cards!`);
      }
    }

    const isFreeChoiceAfterHoldOn = (gameState.topCard.number === 1 && gameState.lastPlayerId === userId);
    if (!isFreeChoiceAfterHoldOn && !WhotEngine.validateMove(playedCard, gameState.topCard, gameState.requestedShape)) {
      return socket.emit('errorMsg', "Invalid card move!");
    }

    playerHand.splice(cardIndex, 1);
    gameState.topCard = playedCard;
    gameState.lastPlayerId = userId;
    gameState.requestedShape = playedCard.number === 20 ? requestedShape : null;

    if (playerHand.length === 0) return handleRoundEnd(roomId, userId);

    let advanceTurn = 1;

    if (playedCard.number === 1) {
      advanceTurn = 0;
      io.to(roomId).emit('gameAlert', { message: `Hold On played! You can play any card of your choice.` });
    } else if (playedCard.number === 5) {
      gameState.pendingPick3Count += 1;
      gameState.pick3InitiatorId = userId;
      advanceTurn = 1;
      const nextPlayerId = gameState.players[(gameState.turnIndex + 1) % gameState.players.length];
      const targetSocketId = userSockets[nextPlayerId];
      if (targetSocketId) {
        io.to(targetSocketId).emit('pickCardAlert', {
          message: `Pick 3 played against you! Defend or draw ${gameState.pendingPick3Count * 3} cards.`,
          cardsToDraw: gameState.pendingPick3Count * 3
        });
      }
    } else if (playedCard.number === 2) {
      const nextPlayerIndex = (gameState.turnIndex + 1) % gameState.players.length;
      const nextPlayerId = gameState.players[nextPlayerIndex];
      for (let i = 0; i < 2; i++) {
        if (gameState.deck.length > 0) gameState.hands[nextPlayerId].push(gameState.deck.pop());
      }
      advanceTurn = 0;
      const targetSocketId = userSockets[nextPlayerId];
      if (targetSocketId) {
        io.to(targetSocketId).emit('pickCardAlert', { message: `Pick 2 played against you! 2 cards added.`, cardsToDraw: 2 });
      }
    } else if (playedCard.number === 14) {
      gameState.players.forEach((pId) => {
        if (pId !== userId && gameState.deck.length > 0) {
          gameState.hands[pId].push(gameState.deck.pop());
          const oppSocketId = userSockets[pId];
          if (oppSocketId) io.to(oppSocketId).emit('pickCardAlert', { message: `General Market! 1 card added.`, cardsToDraw: 1 });
        }
      });
      advanceTurn = 0;
    } else if (playedCard.number === 8) {
      advanceTurn = 2;
    }

    gameState.turnIndex = (gameState.turnIndex + advanceTurn) % gameState.players.length;
    io.to(roomId).emit('gameStateUpdate', gameState);
  });

  socket.on('drawCard', ({ roomId, userId }) => {
    const gameState = activeGames[roomId];
    if (!gameState) return;
    if (gameState.players[gameState.turnIndex] !== userId) return;

    let cardsToDrawCount = 1;
    if (gameState.pendingPick3Count > 0) {
      cardsToDrawCount = gameState.pendingPick3Count * 3;
      gameState.pendingPick3Count = 0;
    } else if (gameState.pendingPick2Count > 0) {
      cardsToDrawCount = gameState.pendingPick2Count * 2;
      gameState.pendingPick2Count = 0;
    }

    for (let i = 0; i < cardsToDrawCount; i++) {
      if (gameState.deck.length > 0) gameState.hands[userId].push(gameState.deck.pop());
    }

    gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
    io.to(roomId).emit('gameStateUpdate', gameState);
  });

  socket.on('sendGameMsg', ({ roomId, username, message }) => {
    io.to(roomId).emit('receiveGameMsg', { username, message });
  });

  socket.on('leaveRoom', async ({ roomId, userId }) => {
    const gameState = activeGames[roomId];
    if (gameState) {
      const remainingPlayers = gameState.players.filter((id) => id !== userId);
      if (remainingPlayers.length === 1) {
        await resolveGameVictory(roomId, remainingPlayers[0]);
        io.to(roomId).emit('playerForfeited', { message: 'Your opponent left the game. You win by forfeit!' });
      } else {
        io.to(roomId).emit('playerForfeited', { message: 'A player has quit the room.' });
      }
      delete activeGames[roomId];
      socket.leave(roomId);
    }
  });

  socket.on('disconnecting', () => {
    const userId = Object.keys(userSockets).find((key) => userSockets[key] === socket.id);
    if (userId) {
      delete userSockets[userId];
      for (const roomId of socket.rooms) {
        if (activeGames[roomId]) {
          const timerKey = `${roomId}_${userId}`;
          disconnectTimers[timerKey] = setTimeout(async () => {
            const gameState = activeGames[roomId];
            if (gameState && gameState.players.includes(userId)) {
              gameState.players = gameState.players.filter((id) => id !== userId);
              io.to(roomId).emit('playerForfeited', { message: 'Player removed for 5-minute inactivity. Points forfeited!' });
              if (gameState.players.length === 1) {
                await resolveGameVictory(roomId, gameState.players[0]);
              } else if (gameState.players.length === 0) {
                delete activeGames[roomId];
              } else {
                gameState.turnIndex = gameState.turnIndex % gameState.players.length;
                io.to(roomId).emit('gameStateUpdate', gameState);
              }
              delete disconnectTimers[timerKey];
            }
          }, 300000);
        }
      }
    }
  });
});

// Scoring Utilities
function calculateHandScore(hand) {
  return hand.reduce((total, card) => {
    if (card.shape === 'Star') return total + card.number * 2;
    return total + card.number;
  }, 0);
}

async function handleRoundEnd(roomId, roundWinnerId) {
  const gameState = activeGames[roomId];
  if (!gameState) return;

  const scores = {};
  let highestScore = -1;
  let playerToEliminate = null;

  gameState.players.forEach((pId) => {
    if (pId !== roundWinnerId) {
      const score = calculateHandScore(gameState.hands[pId] || []);
      scores[pId] = score;
      if (score > highestScore) {
        highestScore = score;
        playerToEliminate = pId;
      }
    } else {
      scores[pId] = 0;
    }
  });

  gameState.players = gameState.players.filter((id) => id !== playerToEliminate);

  io.to(roomId).emit('roundEnded', {
    roundWinnerId,
    scores,
    eliminatedPlayerId: playerToEliminate,
    remainingPlayersCount: gameState.players.length
  });

  if (gameState.players.length === 1) {
    await resolveGameVictory(roomId, gameState.players[0]);
  } else {
    setTimeout(() => {
      startNextRound(roomId);
    }, 4000);
  }
}

function startNextRound(roomId) {
  const gameState = activeGames[roomId];
  if (!gameState) return;

  const deck = WhotEngine.generateDeck();
  const hands = {};
  gameState.players.forEach((pId) => {
    hands[pId] = deck.splice(0, 6);
  });

  gameState.deck = deck;
  gameState.hands = hands;
  gameState.topCard = deck.pop();
  gameState.turnIndex = 0;
  gameState.requestedShape = null;
  gameState.pendingPick3Count = 0;
  gameState.pendingPick2Count = 0;

  io.to(roomId).emit('gameStateUpdate', gameState);
}

async function resolveGameVictory(roomId, ultimateWinnerId) {
  const gameState = activeGames[roomId];
  if (!gameState) return;

  try {
    const totalPot = gameState.stake * gameState.maxPlayers;
    const ownerCommission = totalPot * 0.2;
    const winnerPayout = totalPot * 0.8;

    await User.findByIdAndUpdate(ultimateWinnerId, {
      $inc: { pointsBalance: winnerPayout }
    });

    await GameSession.findOneAndUpdate(
      { roomId },
      {
        status: 'completed',
        winner: ultimateWinnerId,
        houseRakeGenerated: ownerCommission,
        winnerPayout: winnerPayout
      }
    );

    io.to(roomId).emit('gameOver', {
      winnerId: ultimateWinnerId,
      winnerPayout,
      ownerCommission,
      totalPot
    });

    delete activeGames[roomId];
  } catch (err) {
    console.error('Error resolving game victory split:', err);
  }
}

server.listen(process.env.PORT || 3000, () => console.log('Server running on port 3000'));
