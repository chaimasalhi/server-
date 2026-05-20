const mongoose = require('mongoose');

const rfidSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true },
  nom: { type: String, required: true },
  prenom: { type: String, required: true },
  poste: { type: String, default: '' },
  actif: { type: Boolean, default: true },
  ajoutePar: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // plus de required: true
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Rfid', rfidSchema);