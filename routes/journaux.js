const router  = require('express').Router();
const Journal = require('../models/Journal');
const { auth, isAdmin, isAdminOrTech } = require('../config/middleware/authMiddleware');

// ══════════════════════════════════════════════════════════
//  GET /api/journaux
//  Liste tous les journaux d'accès avec filtres optionnels
//  Accès : Admin + Technicien
//  Query params :
//    ?statut=autorise|refuse
//    ?uid=XXXX
//    ?limite=50       (défaut 100)
//    ?page=1
// ══════════════════════════════════════════════════════════
router.get('/', auth, isAdminOrTech, async (req, res) => {
  try {
    const { statut, uid, limite = 100, page = 1 } = req.query;

    const filtre = {};
    if (statut) filtre.statut = statut;
    if (uid)    filtre.uid    = uid.toUpperCase().trim();

    const skip  = (parseInt(page) - 1) * parseInt(limite);
    const total = await Journal.countDocuments(filtre);

    const journaux = await Journal.find(filtre)
      .sort({ horodatage: -1 })
      .skip(skip)
      .limit(parseInt(limite));

    res.json({
      total,
      page      : parseInt(page),
      totalPages: Math.ceil(total / parseInt(limite)),
      journaux,
    });
  } catch (e) {
    console.error('❌ GET JOURNAUX ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/journaux/stats
//  Statistiques des accès (nombre autorisés, refusés, etc.)
//  Accès : Admin + Technicien
// ══════════════════════════════════════════════════════════
router.get('/stats', auth, isAdminOrTech, async (req, res) => {
  try {
    const total    = await Journal.countDocuments();
    const autorise = await Journal.countDocuments({ statut: 'autorise' });
    const refuse   = await Journal.countDocuments({ statut: 'refuse' });

    // Accès des dernières 24h
    const depuis24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dernieres24h = await Journal.countDocuments({ horodatage: { $gte: depuis24h } });

    // Dernier accès
    const dernierAcces = await Journal.findOne().sort({ horodatage: -1 });

    res.json({
      total,
      autorise,
      refuse,
      dernieres24h,
      dernierAcces,
    });
  } catch (e) {
    console.error('❌ GET JOURNAUX STATS ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/journaux/:id
//  Détail d'un journal
//  Accès : Admin + Technicien
// ══════════════════════════════════════════════════════════
router.get('/:id', auth, isAdminOrTech, async (req, res) => {
  try {
    const journal = await Journal.findById(req.params.id);
    if (!journal) return res.status(404).json({ message: 'Journal introuvable' });
    res.json(journal);
  } catch (e) {
    console.error('❌ GET JOURNAL/:id ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/journaux
//  Créer un journal manuellement (depuis ESP32 ou facial)
//  Accès : Public (appelé par le système ESP32)
// ══════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  const { uid, nom, prenom, typeAcces, statut, motifRefus } = req.body;

  if (!uid || !statut)
    return res.status(400).json({ message: 'UID et statut sont requis' });

  try {
    const journal = await Journal.create({
      uid       : uid.toUpperCase().trim(),
      nom       : nom    || 'Inconnu',
      prenom    : prenom || '',
      typeAcces : typeAcces || 'rfid',
      statut,
      motifRefus: motifRefus || '',
    });

    console.log(`📝 Journal créé : ${uid} — ${statut}`);
    res.status(201).json({ message: 'Journal enregistré ✅', journal });
  } catch (e) {
    console.error('❌ POST JOURNAL ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/journaux/purger
//  Supprimer les journaux de plus de 30 jours
//  Accès : Admin uniquement
// ══════════════════════════════════════════════════════════
router.delete('/purger', auth, isAdmin, async (req, res) => {
  try {
    const il_y_a_30j = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await Journal.deleteMany({ horodatage: { $lt: il_y_a_30j } });

    console.log(`🗑️ Journaux purgés : ${result.deletedCount} entrées`);
    res.json({ message: `${result.deletedCount} journaux supprimés ✅` });
  } catch (e) {
    console.error('❌ PURGER JOURNAUX ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

module.exports = router;