const router    = require('express').Router();
const fs        = require('fs');
const path      = require('path');
const { auth, isAdmin, isAdminOrTech } = require('../config/middleware/authMiddleware');

const CSV_FILE = path.join(__dirname, '../temperature_data.csv');

// ══════════════════════════════════════════════════════════
//  GET /api/historique
//  Retourne l'historique des mesures depuis le CSV
//  Accès : Admin uniquement
//  Query params :
//    ?limite=100   (défaut 200)
//    ?statut=NORMAL|AVERTISSEMENT|DANGER
// ══════════════════════════════════════════════════════════
router.get('/', auth, isAdmin, async (req, res) => {
  try {
    if (!fs.existsSync(CSV_FILE))
      return res.json({ total: 0, mesures: [] });

    const { limite = 200, statut } = req.query;

    const contenu = fs.readFileSync(CSV_FILE, 'utf8');
    const lignes  = contenu.split('\n').filter(l => l.trim() !== '');

    // Ignorer l'entête
    const donnees = lignes.slice(1).map(ligne => {
      const [timestamp, temperature, statutLigne] = ligne.split(',');
      return {
        timestamp  : timestamp?.trim()   || '',
        temperature: parseFloat(temperature) || 0,
        statut     : statutLigne?.trim() || '',
      };
    }).filter(d => d.timestamp !== '');

    // Filtrer par statut si demandé
    const filtrees = statut
      ? donnees.filter(d => d.statut.toUpperCase() === statut.toUpperCase())
      : donnees;

    // Retourner les dernières N lignes
    const limitee = filtrees.slice(-parseInt(limite)).reverse();

    res.json({
      total : filtrees.length,
      retour: limitee.length,
      mesures: limitee,
    });
  } catch (e) {
    console.error('❌ GET HISTORIQUE ERROR:', e);
    res.status(500).json({ message: 'Erreur lecture historique' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/historique/stats
//  Statistiques des mesures (min, max, moyenne)
//  Accès : Admin uniquement
// ══════════════════════════════════════════════════════════
router.get('/stats', auth, isAdmin, async (req, res) => {
  try {
    if (!fs.existsSync(CSV_FILE))
      return res.json({ total: 0 });

    const contenu = fs.readFileSync(CSV_FILE, 'utf8');
    const lignes  = contenu.split('\n').filter(l => l.trim() !== '').slice(1);

    const temperatures = lignes
      .map(l => parseFloat(l.split(',')[1]))
      .filter(v => !isNaN(v));

    if (temperatures.length === 0)
      return res.json({ total: 0, message: 'Aucune donnée' });

    const min     = Math.min(...temperatures);
    const max     = Math.max(...temperatures);
    const moyenne = (temperatures.reduce((a, b) => a + b, 0) / temperatures.length).toFixed(2);

    const normales      = lignes.filter(l => l.includes('NORMAL')).length;
    const avertissement = lignes.filter(l => l.includes('AVERTISSEMENT')).length;
    const danger        = lignes.filter(l => l.includes('DANGER')).length;

    res.json({
      total: temperatures.length,
      temperature: { min, max, moyenne: parseFloat(moyenne) },
      parStatut: { NORMAL: normales, AVERTISSEMENT: avertissement, DANGER: danger },
    });
  } catch (e) {
    console.error('❌ HISTORIQUE STATS ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/historique/export
//  Télécharger le CSV brut
//  Accès : Admin uniquement
// ══════════════════════════════════════════════════════════
router.get('/export', auth, isAdmin, (req, res) => {
  try {
    if (!fs.existsSync(CSV_FILE))
      return res.status(404).json({ message: 'Aucune donnée disponible' });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="historique_temperature.csv"');
    fs.createReadStream(CSV_FILE).pipe(res);
  } catch (e) {
    console.error('❌ EXPORT CSV ERROR:', e);
    res.status(500).json({ message: 'Erreur export' });
  }
});

module.exports = router;