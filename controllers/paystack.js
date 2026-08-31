const axios = require('axios');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

exports.initializeDeposit = async (req, res) => {
  try {
    const { amount } = req.body;
    const user = req.user;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid deposit amount' });
    }

    const email = user.email || `${user.username || 'user'}_${user.telegramId || user._id}@gmail.com`;
    const reference = 'TRX_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

    // Save pending transaction
    await Transaction.create({
      user: user._id,
      amount: amount,
      type: 'deposit',
      status: 'pending',
      reference: reference
    });

    return res.json({
      success: true,
      email: email,
      reference: reference
    });
  } catch (error) {
    console.error('Paystack Initialize Error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error during initialization' });
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
    const { reference, trxref } = req.query;
    const paymentRef = reference || trxref;

    if (!paymentRef) {
      return res.redirect('/wallet');
    }

    const txn = await Transaction.findOne({ reference: paymentRef, status: 'pending' });
    if (!txn) {
      return res.redirect('/wallet');
    }

    // Verify with Paystack
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${paymentRef}`,
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      }
    );

    const paystackData = response.data?.data;

    if (paystackData && paystackData.status === 'success') {
      txn.status = 'success';
      await txn.save();

      // 1. Credit the depositing user (1 NGN = 1 Point)
      const depositingUser = await User.findByIdAndUpdate(
        txn.user,
        { $inc: { pointsBalance: txn.amount } },
        { new: true }
      );

      // 2. REFERRAL REWARD CHECK: If deposit >= 500 and user has a referrer
      if (
        txn.amount >= 500 &&
        depositingUser.referredBy &&
        !depositingUser.hasEarnedReferralReward
      ) {
        // Credit 50 points to referrer
        await User.findByIdAndUpdate(depositingUser.referredBy, {
          $inc: { pointsBalance: 50 }
        });

        // Mark reward as claimed so future deposits don't trigger it again
        depositingUser.hasEarnedReferralReward = true;
        await depositingUser.save();

        console.log(`Referral Reward: Credited 50 points to user ${depositingUser.referredBy}`);
      }
    } else {
      txn.status = 'failed';
      await txn.save();
    }

    return res.redirect('/wallet?status=success');
  } catch (err) {
    console.error('Verify Deposit Error:', err.response?.data || err.message);
    return res.redirect('/wallet?status=error');
  }
};