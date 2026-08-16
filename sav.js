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
      req.flash("error_msg", "Invalid amount");
      return res.redirect("/withdrawal");
    }

    // Get user balance
    if (!user || user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    if (amount < 3) {
      return res.status(400).json({ error: 'Minimum withdrawal is 1,000 points' });
    }

    if (userId.balance >= 3) {
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

      const transaction = new Transaction({userId, amount, type: "withdrawal", status: "completed"});
      transaction.save();

      fetch("https://faucetpay.io/api/v1/send", {
            method: "POST",
            body: data,
      })
          .then(response => response.json())
          .then(json => {
            if (json.status === 200) {
              user.balance -= amount;
              user.save();
              req.user.balance = user.balance;
              res.json({ message: 'Withdrawal successful!' });
            } else {
              res.status(400).json({ error: 'FaucetPay error. Refunded points.' });
            }
          })
          .catch(() => {
            req.flash("error_msg", "Minimum balance required: 3 USDT");
            return res.render("../views/new/withdrawal",{user, appName: process.env.APP_NAME, title: 'FluwentCash'});
          });
    }
  } catch (error) {
    console.error(error);
    req.flash("error_msg", "server error");
    return res.render("../views/new/withdrawal",{user, appName: process.env.APP_NAME, title: 'FluwentCash'});
  }
};


