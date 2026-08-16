const axios = require('axios');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

exports.withdrawBank = async (req, res) => {
  try {
    const { amount, bankCode, accountNumber } = req.body;
    const user = await User.findById(req.user.id);

    if (amount < 1000) return res.status(400).json({ error: 'Minimum withdrawal is 1,000 points' });
    if (user.pointsBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    user.pointsBalance -= amount;
    await user.save();

    const ref = `BANK_${Date.now()}_${user._id}`;
    const txn = await Transaction.create({
      user: user._id,
      type: 'withdrawal',
      amount,
      channel: 'opay',
      reference: ref,
      status: 'pending'
    });

    const response = await axios.post('https://api.opayweb.com/api/v3/transfer/toBank', {
      reference: ref,
      amount: (amount * 100).toString(),
      currency: 'NGN',
      country: 'NG',
      receiver: { bankCode, bankAccountNo: accountNumber }
    }, {
      headers: { Authorization: `Bearer ${process.env.OPAY_SECRET_KEY}` }
    });

    if (response.data.code === '00000') {
      txn.status = 'success';
      await txn.save();
      res.json({ message: 'Bank payout successful' });
    } else {
      user.pointsBalance += amount;
      await user.save();
      txn.status = 'failed';
      await txn.save();
      res.status(400).json({ error: 'Payout failed. Balance restored.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Bank transfer processing failed' });
  }
};