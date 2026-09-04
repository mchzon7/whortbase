const crypto = require('crypto');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

exports.handlePostback = async (req, res) => {
  try {
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

    if (!userid || !currencyAmount) {
      return res.status(400).send('Missing required parameters.');
    }

    const secretKey = process.env.TIMEWALL_SECRET_KEY;

    // 1. Check Hash Signature against all TimeWall parameter combinations
    if (secretKey && hash) {
      // Combination A: Standard txid + secretKey
      const hashA = crypto.createHash('md5').update(`${txid || ''}${secretKey}`).digest('hex');
      
      // Combination B: Withdraw/Task ID or User ID variations sent by TimeWall
      const hashB = crypto.createHash('md5').update(`${withdrawid || txid || ''}${secretKey}`).digest('hex');
      const hashC = crypto.createHash('md5').update(`${userid}${secretKey}`).digest('hex');

      const incomingHash = hash.toLowerCase();

      if (incomingHash !== hashA.toLowerCase() && 
          incomingHash !== hashB.toLowerCase() && 
          incomingHash !== hashC.toLowerCase()) {
        
        console.warn(`TimeWall Postback: Hash mismatch for txid ${txid || withdrawid}`);
        return res.status(403).send('Invalid signature hash');
      }
    }

    const amountToCredit = parseFloat(currencyAmount);
    if (isNaN(amountToCredit) || amountToCredit <= 0) {
      return res.status(400).send('Invalid currency amount.');
    }

    // 2. Find User in Database
    const user = await User.findById(userid);
    if (!user) {
      console.warn(`TimeWall Postback: User ${userid} not found.`);
      return res.status(404).send('User not found.');
    }

    // 3. Prevent Duplicate Processing
    const referenceId = withdrawid ? `TW_WD_${withdrawid}` : `TW_${txid}`;
    const existingTxn = await Transaction.findOne({ reference: referenceId });
    
    if (existingTxn) {
      return res.status(200).send('OK');
    }

    // 4. Credit User Balance
    user.pointsBalance += amountToCredit;
    await user.save();

    // 5. Log Transaction Record
    await Transaction.create({
      user: user._id,
      amount: amountToCredit,
      type: 'offerwall',
      status: 'success',
      reference: referenceId,
      details: {
        provider: 'TimeWall',
        revenue,
        ip,
        withdrawid,
        type,
        offername,
        offerdetail,
        reason
      }
    });

    console.log(`TimeWall Success: Credited ${amountToCredit} points to user ${user._id}`);
    
    // TimeWall requires a 200 OK HTTP response
    return res.status(200).send('OK');

  } catch (err) {
    console.error('TimeWall Postback Error:', err);
    return res.status(500).send('Internal Server Error');
  }
};