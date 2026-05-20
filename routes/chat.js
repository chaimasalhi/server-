// routes/chat.js
// ─────────────────────────────────────────────────────────────
//  POST /api/chat — Chatbot Navigator avec Groq (LLaMA 3)
//  npm install groq-sdk
//  Dans .env : GROQ_API_KEY=gsk_...
// ─────────────────────────────────────────────────────────────

const router = require('express').Router();
const Groq   = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ══════════════════════════════════════════════════════════
//  POST /api/chat
//  Reçoit : { message, history[], sensorContext (string) ou sensorData (object) }
//  Retourne : { reply }
// ══════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  // ✅ On récupère sensorContext (nouveau format) et sensorData (ancien)
  const { message, history = [], sensorData = null, sensorContext: sensorContextFromBody } = req.body;

  if (!message) return res.status(400).json({ error: 'Message requis' });

  try {
    // ── Construire le contexte capteurs ─────────────────────
    let sensorContext = 'Aucune donnée capteur disponible pour le moment.';

    // NOUVEAU : si le client envoie sensorContext (une chaîne déjà formatée), on l'utilise directement
    if (sensorContextFromBody && typeof sensorContextFromBody === 'string') {
      sensorContext = sensorContextFromBody;
    }
    // ANCIEN : sinon, on construit à partir de l'objet sensorData (pour compatibilité)
    else if (sensorData) {
      const temp  = sensorData.temperature;
      const humid = sensorData.humidite;
      const gaz   = sensorData.gaz;
      const eau   = sensorData.eau;
      const pred  = sensorData.prediction;

      sensorContext = `
=== DONNÉES CAPTEURS EN TEMPS RÉEL ===
${temp  ? `🌡️ Température : ${temp.temperature}°C — Statut : ${temp.statut}` : '🌡️ Température : non disponible'}
${humid ? `💧 Humidité    : ${humid.humidite}% — Statut : ${humid.statut}`   : '💧 Humidité : non disponible'}
${gaz   ? `⚗️  Gaz         : Statut : ${gaz.statut}`                          : '⚗️  Gaz : non disponible'}
${eau   ? `🚰 Eau         : Statut : ${eau.statut}`                           : '🚰 Eau : non disponible'}
${pred  ? `
🤖 PRÉDICTION IA :
   - Température actuelle : ${pred.temperatureActuelle}°C
   - Température prédite  : ${pred.temperaturePredite ? pred.temperaturePredite + '°C dans ' + pred.dansMinutes + ' min' : 'stable'}
   - Tendance             : ${pred.trend}
   - Alerte               : ${pred.alerte}
   - Message              : ${pred.message}
` : ''}
Dernière mise à jour : ${sensorData.lastUpdate || 'inconnue'}
=====================================`;
    }

    // ── Prompt système ──────────────────────────────────────
    const systemPrompt = `Tu es Navigator, un assistant IA expert en surveillance de salle réseau informatique pour OMMP Bizerte (Tunisie).

Tu surveilles en temps réel :
- La température et l'humidité (normes TIA-942 : température entre 18°C et 27°C, humidité entre 40% et 60%)
- Les détections de gaz et fuites d'eau
- Les prédictions de surchauffe par régression linéaire
- Les accès et la sécurité

Tes règles :
1. Réponds TOUJOURS en français
2. Sois concis, précis et professionnel
3. Si alerte DANGER → donne des actions immédiates numérotées
4. Utilise des emojis pertinents pour la lisibilité
5. Tu t'appelles Navigator — ne mentionne jamais Groq ou LLaMA

${sensorContext}`;

    // ── Construire l'historique ──────────────────────────────
    // Groq attend : [{ role: 'user'|'assistant', content: '...' }]
    const messages = [
      { role: 'system', content: systemPrompt },
      // Historique des messages précédents (max 10 pour économiser les tokens)
      ...history
        .slice(-10)
        .filter(m => m.text && m.text.trim())
        .map(m => ({
          role   : m.isUser ? 'user' : 'assistant',
          content: m.text,
        })),
      // Message actuel
      { role: 'user', content: message },
    ];

    // ── Appel Groq ───────────────────────────────────────────
    const completion = await groq.chat.completions.create({
      model      : 'llama-3.3-70b-versatile', // Modèle LLaMA 3.3 70B
      messages,
      max_tokens : 500,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content
      ?? "Désolé, je n'ai pas pu générer une réponse.";

    console.log(`💬 Chat — User: "${message.substring(0, 40)}..." | OK`);
    res.json({ reply });

  } catch (e) {
    console.error('❌ GROQ ERROR:', e.message);
    res.status(500).json({
      error: 'Erreur IA',
      reply: "Désolé, je rencontre une difficulté. Vérifiez les capteurs manuellement.",
    });
  }
});

module.exports = router;