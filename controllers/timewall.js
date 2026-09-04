const crypto = require('crypto');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

exports.handlePostback = async (req, res) => {
  try {
    // TimeWall sends parameters via GET query
    const {
      userid,
      txid,
      revenue,
      currencyAmount,
      hash,
      ip,
      type,
      withdrawid,
      reason,
      offername,
      offerdetail
    } = req.query;

    if (!userid || !txid || !currencyAmount || !hash) {
      return res.status(400).send('Missing required parameters.');
    }

    const secretKey = process.env.TIMEWALL_SECRET_KEY;

    // 1. Verify Security Hash (MD5 hash of txid + secretKey)
    if (secretKey) {
      const calculatedHash = crypto
        .createHash('md5')
        .update(`${txid}${secretKey}`)
        .digest('hex');

      if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
        console.warn(`TimeWall Postback: Invalid hash signature for txid ${txid}`);
        return res.status(403).send('Invalid signature hash.');
      }
    }

    const amountToCredit = parseFloat(currencyAmount);
    if (isNaN(amountToCredit) || amountToCredit <= 0) {
      return res.status(400).send('Invalid currency amount.');
    }

    // 2. Find User
    const user = await User.findById(userid);
    if (!user) {
      return res.status(404).send('User not found.');
    }

    // 3. Handle Chargebacks/Reversals (type 2 usually indicates chargebacks in standard offerwalls)
    if (type === '2' || type === 'chargeback' || type === 'reversal') {
      const existingTxn = await Transaction.findOne({ reference: txid });
      if (existingTxn && existingTxn.status !== 'reversed') {
        user.pointsBalance = Math.max(0, user.pointsBalance - amountToCredit);
        await user.save();

        existingTxn.status = 'reversed';
        await existingTxn.save();
      }
      return res.send('OK');
    }

    // 4. Prevent Duplicate Payouts for the same transaction ID
    const existingTxn = await Transaction.findOne({ reference: txid });
    if (existingTxn) {
      return res.send('OK'); // Already processed
    }

    // 5. Credit Points & Log Transaction
    user.pointsBalance += amountToCredit;
    await user.save();

    await Transaction.create({
      user: user._id,
      amount: amountToCredit,
      type: 'offerwall',
      status: 'success',
      reference: txid,
      details: {
        provider: 'TimeWall',
        revenue,
        ip,
        withdrawid,
        offername,
        offerdetail,
        reason
      }
    });

    console.log(`TimeWall: Credited ${amountToCredit} points to user ${user.username} (TxID: ${txid})`);
    return res.send('OK'); // TimeWall expects "OK" text response

  } catch (err) {
    console.error('TimeWall Postback Error:', err);
    return res.status(500).send('Internal Server Error');
  }
};