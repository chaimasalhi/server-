const router = require('express').Router();
const Alerte = require('../models/Alerte');
const { auth, isAdmin, isAdminOrTech } = require('../../../../server-/middleware/authMiddleware');

// ══════════════════════════════════════════════════════════
//  GET /api/alertes
//  Liste toutes les alertes avec filtres optionnels
//  Accès : Admin + Technicien
//  Query params :
//    ?type=temperature|humidite|gaz|eau|intrusion|visage
//    ?niveau=avertissement|danger|critique
//    ?resolue=true|false
//    ?limite=50
//    ?page=1
// ══════════════════════════════════════════════════════════
router.get('/', auth, isAdminOrTech, async (req, res) => {
  try {
    const { type, niveau, resolue, limite = 50, page = 1 } = req.query;

    const filtre = {};
    if (type)    filtre.type    = type;
    if (niveau)  filtre.niveau  = niveau;
    if (resolue !== undefined) filtre.resolue = resolue === 'true';

    const skip  = (parseInt(page) - 1) * parseInt(limite);
    const total = await Alerte.countDocuments(filtre);

    const alertes = await Alerte.find(filtre)
      .populate('resoluePar', 'nom prenom')
      .sort({ horodatage: -1 })
      .skip(skip)
      .limit(parseInt(limite));

    res.json({
      total,
      page      : parseInt(page),
      totalPages: Math.ceil(total / parseInt(limite)),
      alertes,
    });
  } catch (e) {
    console.error('❌ GET ALERTES ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/alertes/stats
//  Statistiques des alertes
//  Accès : Admin + Technicien
// ══════════════════════════════════════════════════════════
router.get('/stats', auth, isAdminOrTech, async (req, res) => {
  try {
    const total       = await Alerte.countDocuments();
    const nonResolues = await Alerte.countDocuments({ resolue: false });
    const resolues    = await Alerte.countDocuments({ resolue: true });
    const critiques   = await Alerte.countDocuments({ niveau: 'critique', resolue: false });
    const dangers     = await Alerte.countDocuments({ niveau: 'danger',   resolue: false });

    // Par type (non résolues)
    const parType = await Alerte.aggregate([
      { $match: { resolue: false } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]);

    // Alertes des dernières 24h
    const depuis24h    = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dernieres24h = await Alerte.countDocuments({ horodatage: { $gte: depuis24h } });

    res.json({
      total,
      nonResolues,
      resolues,
      critiques,
      dangers,
      dernieres24h,
      parType: parType.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
    });
  } catch (e) {
    console.error('❌ ALERTES STATS ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/alertes/:id
//  Détail d'une alerte
//  Accès : Admin + Technicien
// ══════════════════════════════════════════════════════════
router.get('/:id', auth, isAdminOrTech, async (req, res) => {
  try {
    const alerte = await Alerte.findById(req.params.id)
      .populate('resoluePar', 'nom prenom');
    if (!alerte) return res.status(404).json({ message: 'Alerte introuvable' });
    res.json(alerte);
  } catch (e) {
    console.error('❌ GET ALERTE/:id ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/alertes
//  Créer une alerte (appelée depuis Node.js quand MQTT détecte anomalie)
//  Accès : Public (système interne)
// ══════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  const { type, niveau, valeur, seuil, message } = req.body;

  if (!type || !niveau || !message)
    return res.status(400).json({ message: 'type, niveau et message sont requis' });

  try {
    const alerte = await Alerte.create({
      type,
      niveau,
      valeur : valeur ?? null,
      seuil  : seuil  ?? null,
      message,
    });

    console.log(`🚨 Alerte créée : [${niveau.toUpperCase()}] ${type} — ${message}`);
    res.status(201).json({ message: 'Alerte enregistrée ✅', alerte });
  } catch (e) {
    console.error('❌ POST ALERTE ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur', detail: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  PUT /api/alertes/:id/resoudre
//  Marquer une alerte comme résolue
//  Accès : Admin + Technicien
// ══════════════════════════════════════════════════════════
router.put('/:id/resoudre', auth, isAdminOrTech, async (req, res) => {
  try {
    const alerte = await Alerte.findByIdAndUpdate(
      req.params.id,
      {
        resolue    : true,
        resolueA   : new Date(),
        resoluePar : req.user.id,
      },
      { new: true }
    ).populate('resoluePar', 'nom prenom');

    if (!alerte) return res.status(404).json({ message: 'Alerte introuvable' });

    console.log(`✅ Alerte résolue : ${alerte._id} par ${req.user.nom}`);
    res.json({ message: 'Alerte marquée comme résolue ✅', alerte });
  } catch (e) {
    console.error('❌ RESOUDRE ALERTE ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/alertes/purger
//  Supprimer les alertes résolues de plus de 7 jours
//  Accès : Admin uniquement
// ══════════════════════════════════════════════════════════
router.delete('/purger', auth, isAdmin, async (req, res) => {
  try {
    const il_y_a_7j = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await Alerte.deleteMany({
      resolue  : true,
      resolueA : { $lt: il_y_a_7j },
    });

    console.log(`🗑️ Alertes purgées : ${result.deletedCount} entrées`);
    res.json({ message: `${result.deletedCount} alertes supprimées ✅` });
  } catch (e) {
    console.error('❌ PURGER ALERTES ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

module.exports = router;