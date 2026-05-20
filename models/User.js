const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String },
  role: { type: String, enum: ['admin', 'technicien', 'employe'], default: 'employe' },
  nom: { type: String, required: true },
  prenom: { type: String, required: true },
  isApproved: { type: Boolean, default: false },
  fcmTokens: [String],
  accessToken: String,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);