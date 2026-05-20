const router = require('express').Router();
const Rfid   = require('../models/Rfid');
const Journal = require('../models/Journal');
const { auth, isAdmin, isAdminOrTech } = require('../config/middleware/authMiddleware');

// GET /api/rfid
router.get('/', auth, isAdminOrTech, async (req, res) => {
  try {
    const rfids = await Rfid.find().populate('ajoutePar', 'nom prenom').sort({ createdAt: -1 });
    res.json(rfids);
  } catch (e) {
    console.error('❌ GET RFID ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// POST /api/rfid – AJOUT BADGE (admin)
router.post('/', auth, isAdmin, async (req, res) => {
  const { uid, nom, prenom, poste } = req.body;

  if (!uid || !nom || !prenom)
    return res.status(400).json({ message: 'UID, nom et prénom sont requis' });

  try {
    const existing = await Rfid.findOne({ uid: uid.toUpperCase().trim() });
    if (existing)
      return res.status(400).json({ message: 'Cet UID est déjà enregistré' });

    const newRfid = {
      uid: uid.toUpperCase().trim(),
      nom,
      prenom,
      poste: poste || '',
      actif: true,
    };

    // ✅ Ne pas ajouter ajoutePar pour l'admin hardcodé
    if (req.user.id !== 'admin_hardcoded') {
      newRfid.ajoutePar = req.user.id;
    }

    const rfid = await Rfid.create(newRfid);

    console.log(`✅ RFID ajouté : ${uid} — ${prenom} ${nom}`);
    res.status(201).json({ message: 'UID ajouté avec succès ✅', rfid });
  } catch (e) {
    console.error('❌ POST RFID ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur', detail: e.message });
  }
});

// PUT /api/rfid/:id – modification
router.put('/:id', auth, isAdmin, async (req, res) => {
  const { uid, nom, prenom, poste, actif } = req.body;
  try {
    if (uid) {
      const existing = await Rfid.findOne({ uid: uid.toUpperCase().trim(), _id: { $ne: req.params.id } });
      if (existing) return res.status(400).json({ message: 'Cet UID est déjà utilisé' });
    }
    const updated = await Rfid.findByIdAndUpdate(
      req.params.id,
      {
        ...(uid && { uid: uid.toUpperCase().trim() }),
        ...(nom && { nom }),
        ...(prenom && { prenom }),
        ...(poste !== undefined && { poste }),
        ...(actif !== undefined && { actif }),
      },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'UID introuvable' });
    res.json({ message: 'UID modifié avec succès ✅', rfid: updated });
  } catch (e) {
    console.error('❌ PUT RFID ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// DELETE /api/rfid/:id
router.delete('/:id', auth, isAdmin, async (req, res) => {
  try {
    const deleted = await Rfid.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'UID introuvable' });
    console.log(`🗑️ RFID supprimé : ${deleted.uid}`);
    res.json({ message: 'UID supprimé avec succès ✅' });
  } catch (e) {
    console.error('❌ DELETE RFID ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// POST /api/rfid/verify – publique pour ESP32
router.post('/verify', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ message: 'UID requis' });
  try {
    const rfid = await Rfid.findOne({ uid: uid.toUpperCase().trim() });
    if (!rfid || !rfid.actif) {
      await Journal.create({
        uid: uid.toUpperCase().trim(),
        nom: rfid ? rfid.nom : 'Inconnu',
        prenom: rfid ? rfid.prenom : '',
        typeAcces: 'rfid',
        statut: 'refuse',
        motifRefus: rfid ? 'Carte désactivée' : 'UID non reconnu',
      });
      return res.status(403).json({ autorise: false, message: rfid ? 'Carte RFID désactivée' : 'UID non autorisé' });
    }
    await Journal.create({
      uid: rfid.uid,
      nom: rfid.nom,
      prenom: rfid.prenom,
      typeAcces: 'rfid',
      statut: 'autorise',
    });
    console.log(`🔓 Accès RFID autorisé : ${rfid.uid} — ${rfid.prenom} ${rfid.nom}`);
    res.json({ autorise: true, message: `Accès autorisé — ${rfid.prenom} ${rfid.nom}`, personne: { nom: rfid.nom, prenom: rfid.prenom, poste: rfid.poste } });
  } catch (e) {
    console.error('❌ VERIFY RFID ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

module.exports = router;