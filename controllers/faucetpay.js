const express = require("express");
const Transaction = require("../models/Transaction");
const User = require("../models/User");


exports.withdrawCrypto = async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    req.flash("error_msg", "please login");
    res.redirect("/login");
  }
  try {
    const user = await User.findById(req.user._id);
    const userId = user;
    const {amount} = req.body;
    const {address} = req.body;

    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Get user balance
    if (!user || user.pointsBalance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    if (amount < 3) {
      return res.status(400).json({ error: 'Minimum withdrawal is 1,000 points' });
    }

    if (userId.pointsBalance >= 3) {
      const user = await User.findById(userId);
      const apiKey = process.env.FAUCETPAY_API_KEY;
      const to = address;
      const amonn = parseInt(amount * 1);
      const currency = "USDT";

      const data = new URLSearchParams();
      data.append("api_key", apiKey);
      data.append("to", to);
      data.append("amount", amonn);
      data.append("currency", currency);

      const ref = `FP_${Date.now()}_${user._id}`;
      const txn = await Transaction.create({
        user: user._id,
        type: 'withdrawal',
        amount,
        channel: 'faucetpay',
        reference: ref,
        status: 'pending'
      });
      fetch("https://faucetpay.io/api/v1/send", {
            method: "POST",
            body: data,
      })
          .then(response => response.json())
          .then(json => {
            if (json.status === 200) {
              user.pointsBalance -= amount;
              user.save();
              req.user.pointsBalance = user.pointsBalance;
              res.json({ message: 'Withdrawal successful!' });
            } else {
              user.pointsBalance += amount;
              user.save();
              txn.status = 'failed';
              txn.save();
              res.status(400).json({ error: 'FaucetPay error. Refunded points.' });
            }
          })
          .catch(() => {
            return res.status(400).json({ error: 'crypto withdrawal filed' });
          });
    }
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: 'server error' });
  }
};


