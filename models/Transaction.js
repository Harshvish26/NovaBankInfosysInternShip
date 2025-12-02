const mongoose = require('mongoose');

const TxSchema = new mongoose.Schema({
  fromAccount: String,
  toAccount: String,
  amount: Number,
  type: String, // deposit, withdraw, transfer
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', TxSchema);
