const axios = require('axios');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

// Helper to generate Binance Pay HMAC SHA512 Signature
function generateBinanceSignature(payload, secretKey) {
  return crypto
    .createHmac('sha512', secretKey)
    .update(payload)
    .digest('hex')
    .toUpperCase();
}

exports.withdrawBinance = async (req, res) => {
  try {
    const { amount, binancePayId, currency } = req.body; // e.g., currency: 'USDT'
    const user = req.user;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid withdrawal amount.' });
    }

    if (!binancePayId) {
      return res.status(400).json({ success: false, message: 'Binance Pay ID or Pay Email is required.' });
    }

    // Check balance
    if (user.pointsBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient points balance.' });
    }

    if (amount < 3) {
      return res.status(400).json({ error: 'Minimum withdrawal is 1,000 points' });
    }

    const withdrawCurrency = currency || 'USDT';
    const requestId = 'WD_BN_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

    // Deduct balance first to lock funds
    user.pointsBalance -= amount;
    await user.save();

    // Log pending transaction
    const txn = await Transaction.create({
      user: user._id,
      amount: amount,
      type: 'withdrawal',
      status: 'pending',
      reference: requestId,
      details: { binancePayId, currency: withdrawCurrency }
    });

    const apiKey = process.env.BINANCE_PAY_API_KEY;
    const apiSecret = process.env.BINANCE_PAY_SECRET_KEY;

    // If Binance credentials aren't set up yet, save as manual processing
    if (!apiKey || !apiSecret) {
      return res.json({
        success: true,
        message: 'Withdrawal submitted successfully. Pending manual admin processing.'
      });
    }

    // Call Binance Pay Direct Payout API
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const body = {
      requestId: requestId,
      batchDetailList: [
        {
          merchantSendId: requestId,
          transferAmount: amount,
          currency: withdrawCurrency,
          receiveType: 'BINANCE_ID', // Or 'PAY_ID' / 'EMAIL'
          receiver: binancePayId,
          remark: 'Game Platform Cashout'
        }
      ]
    };

    const jsonBody = JSON.stringify(body);
    const payloadToSign = `${timestamp}\n${nonce}\n${jsonBody}\n`;
    const signature = generateBinanceSignature(payloadToSign, apiSecret);

    const binanceRes = await axios.post(
      'https://bpay.binanceapi.com/binancepay/openapi/v2/payout/transfer',
      body,
      {
        headers: {
          'content-type': 'application/json',
          'BinancePay-Timestamp': timestamp,
          'BinancePay-Nonce': nonce,
          'BinancePay-Certificate-SN': apiKey,
          'BinancePay-Signature': signature
        }
      }
    );

    if (binanceRes.data && binanceRes.data.status === 'SUCCESS') {
      txn.status = 'success';
      await txn.save();
      return res.json({ success: true, message: 'Binance payout completed successfully!' });
    } else {
      // Revert user funds if API call failed
      user.pointsBalance += amount;
      await user.save();

      txn.status = 'failed';
      await txn.save();

      return res.status(400).json({
        success: false,
        message: binanceRes.data?.errorMessage || 'Binance payout failed.'
      });
    }

  } catch (err) {
    console.error('Binance Withdrawal Error:', err.response?.data || err.message);

    // Revert points balance on server failure
    if (req.user && req.body.amount) {
      await User.findByIdAndUpdate(req.user._id, { $inc: { pointsBalance: req.body.amount } });
    }

    return res.status(500).json({ success: false, message: 'Server error processing Binance withdrawal.' });
  }
};