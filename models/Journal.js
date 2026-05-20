const mongoose = require('mongoose');

const journalSchema = new mongoose.Schema({
  uid: { type: String, required: true },
  nom: { type: String, default: 'Inconnu' },
  prenom: { type: String, default: '' },
  typeAcces: { type: String, enum: ['rfid', 'facial', 'rfid+facial'], default: 'rfid' },
  statut: { type: String, enum: ['autorise', 'refuse'], required: true },
  motifRefus: { type: String, default: '' },
  horodatage: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('Journal', journalSchema);