const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

const ALLOWED_TIMEWALL_IPS = new Set([
  '18.156.132.55',
  '51.81.120.73',
  '142.111.248.18'
]);

function normalizeIp(ip) {
  const value = String(ip || '').trim();
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function getRequestIps(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const addresses = process.env.TIMEWALL_TRUST_PROXY === 'true' && forwarded
    ? String(forwarded).split(',')
    : [req.socket.remoteAddress];

  return addresses.map(normalizeIp).filter(Boolean);
}

exports.handlePostback = async (req, res) => {
  try {
    const payload = { ...req.body, ...req.query };
    const requestIps = getRequestIps(req);

    console.log('--- TIMEWALL INCOMING POSTBACK ---');
    console.log('Incoming IPs:', requestIps);
    console.log('Payload:', payload);

    const skipIpCheck = process.env.TIMEWALL_SKIP_IP_CHECK === 'true';
    const ipAllowed = requestIps.some((ip) => ALLOWED_TIMEWALL_IPS.has(ip));
    if (!skipIpCheck && !ipAllowed) {
      console.error(`SECURITY ERROR: Unauthorized IP address(es) '${requestIps.join(', ')}'.`);
      return res.status(403).send('ERROR: Unauthorized IP address');
    }
    if (skipIpCheck) console.warn('WARNING: TIMEWALL_SKIP_IP_CHECK=true; IP validation is disabled.');

    const { userid, txid, revenue, currency, hash, type, withdrawid, reason, offername, offerdetail, ip } = payload;
    const rawUserId = userid == null ? '' : String(userid);
    const userId = rawUserId.trim().replace(/["']/g, '');
    const externalTxId = txid == null ? '' : String(txid).trim();
    const rawRevenue = revenue == null ? '' : String(revenue);
    const pointsAmount = currency == null ? NaN : Number(String(currency));

    if (!userId || !externalTxId || rawRevenue === '' || !Number.isFinite(pointsAmount) || hash == null || String(hash).trim() === '') {
      console.error('FAILED: Required parameters are missing.', { userid, txid, revenue, hash });
      return res.status(200).send('ERROR_MISSING_PARAMS');
    }

    const secretKey = process.env.TIMEWALL_SECRET_KEY;
    if (!secretKey) {
      console.error('CRITICAL: TIMEWALL_SECRET_KEY is missing.');
      return res.status(500).send('SERVER_ERROR: Missing secret key');
    }

    const expectedHash = crypto.createHash('sha256').update(rawUserId + rawRevenue + secretKey, 'utf8').digest('hex');
    const receivedHash = String(hash).trim().toLowerCase();
    const hashesMatch = receivedHash.length === expectedHash.length &&
      crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedHash));
    if (!hashesMatch) {
      console.error('SECURITY ERROR: Hash mismatch.', { receivedHash, rawUserId, rawRevenue });
      return res.status(200).send('ERROR_INVALID_HASH');
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(200).send('ERROR_INVALID_OBJECT_ID');
    if (await Transaction.findOne({ reference: externalTxId })) return res.status(200).send('1');

    let pointsToApply = pointsAmount;
    let description = `Offer completed: ${offername || 'Unknown offer'}`;
    if (String(type) === '2') {
      pointsToApply = -Math.abs(pointsAmount);
      description = `Withdrawal: ${withdrawid || 'No ID'}`;
    } else if (String(type) === '3') {
      pointsToApply = -Math.abs(pointsAmount);
      description = `Chargeback: ${reason || 'No reason provided'}`;
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $inc: { pointsBalance: pointsToApply } },
      { new: true, runValidators: true }
    );
    if (!updatedUser) return res.status(200).send('ERROR_USER_NOT_FOUND');

    try {
      await Transaction.create({
        user: updatedUser._id,
        amount: pointsToApply,
        type: 'offerwall',
        channel: 'system',
        status: 'success',
        reference: externalTxId,
        details: { provider: 'TimeWall', description, revenue: rawRevenue, currency, ip, type, withdrawid, reason, offername, offerdetail }
      });
    } catch (error) {
      if (error && error.code === 11000) return res.status(200).send('1');
      throw error;
    }

    console.log(`SUCCESS: Applied ${pointsToApply} points to user ${userId}; transaction ${externalTxId}.`);
    return res.status(200).send('1');
  } catch (error) {
    console.error('CRITICAL TIMEWALL ERROR:', error);
    return res.status(500).send('SERVER_ERROR');
  }
};
