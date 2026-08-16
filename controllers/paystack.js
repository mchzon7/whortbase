const axios = require('axios');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

exports.initializeDeposit = async (req, res) => {
  try {
    const { amount } = req.body;
    if (amount < 100) return res.status(400).json({ error: 'Minimum deposit is 100 NGN' });

    const reference = `PAY_${Date.now()}_${req.user.id}`;
    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: req.user.email,
      amount: amount * 100, // Kobo
      reference,
      callback_url: `http://${req.headers.host}/wallet/verify`
    }, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });

    await Transaction.create({
      user: req.user.id,
      type: 'deposit',
      amount: amount,
      channel: 'paystack',
      reference,
      status: 'pending'
    });

    res.json({ authorization_url: response.data.data.authorization_url });
  } catch (err) {
    res.status(500).json({ error: 'Deposit initialization failed' });
  }
};

exports.webhook = async (req, res) => {
  const event = req.body;
  if (event.event === 'charge.success') {
    const ref = event.data.reference;
    const txn = await Transaction.findOne({ reference: ref, status: 'pending' });
    if (txn) {
      txn.status = 'success';
      await txn.save();
      await User.findByIdAndUpdate(txn.user, { $inc: { pointsBalance: txn.amount } });
    }
  }
  res.sendStatus(200);
};

exports.verifyDeposit = async (req, res) => {
  try {
    const { reference } = req.query;
    if (!reference) return res.redirect('/wallet');

    const txn = await Transaction.findOne({ reference, status: 'pending' });
    if (!txn) return res.redirect('/wallet');

    // Verify transaction with Paystack API directly
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });

    if (response.data.data.status === 'success') {
      txn.status = 'success';
      await txn.save();

      // Credit User Points (1 NGN = 1 Point)
      await User.findByIdAndUpdate(txn.user, { $inc: { pointsBalance: txn.amount } });
    }

    res.redirect('/wallet');
  } catch (err) {
    res.redirect('/wallet');
  }
};