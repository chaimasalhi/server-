const router = require('express').Router();
const { auth, isAdminOrTech } = require('../middleware/authMiddleware'); // ✅ import correct
const User = require('../models/User');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');

// ══════════════════════════════════════════════════════════
//  POST /api/notifications/register-token
//  Enregistre le token FCM de l'utilisateur connecté
//  Accès : tous les utilisateurs connectés
// ══════════════════════════════════════════════════════════
router.post('/register-token', auth, async (req, res) => {
  const token = (req.body?.token || '').trim();
  if (!token) return res.status(400).json({ message: 'Token FCM manquant' });

  try {
    await User.updateOne(
      { _id: req.user.id },
      { $addToSet: { fcmTokens: token } }
    );
    res.json({ message: 'Token enregistré ✅' });
  } catch (e) {
    console.error('❌ REGISTER FCM TOKEN ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur', detail: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/notifications/danger-temperature
//  Envoie une notification "Température dangereuse"
//  Accès : Admin + Technicien ✅ (rôles mis à jour)
// ══════════════════════════════════════════════════════════
router.post('/danger-temperature', auth, isAdminOrTech, async (req, res) => {
  const admin = initFirebaseAdmin();

  try {
    const users = await User.find(
      { fcmTokens: { $exists: true, $ne: [] } },
      { fcmTokens: 1 }
    ).lean();

    const tokens = [...new Set(users.flatMap(u => u.fcmTokens || []).filter(Boolean))];
    if (!tokens.length)
      return res.status(200).json({ message: 'Aucun token FCM enregistré', sent: 0 });

    const payload = {
      notification: {
        title: '🌡️ Alerte température',
        body : 'Température dangereuse dans la salle réseau !',
      },
      data: {
        type: 'TEMP_DANGER',
        room: 'SALLE_RESEAU',
      },
      android: {
        priority    : 'high',
        notification: {
          channelId: 'alertes_temperature',
          sound    : 'default',
        },
      },
      apns: {
        payload: { aps: { sound: 'default' } },
        headers: { 'apns-priority': '10' },
      },
    };

    const result = await admin.messaging().sendEachForMulticast({ tokens, ...payload });

    res.json({
      message: 'Notification envoyée ✅',
      sent   : result.successCount,
      failed : result.failureCount,
    });
  } catch (e) {
    console.error('❌ SEND TEMP DANGER NOTIF ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur', detail: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/notifications/send
//  Envoie une notification personnalisée (titre + body)
//  Accès : Admin + Technicien
// ══════════════════════════════════════════════════════════
router.post('/send', auth, isAdminOrTech, async (req, res) => {
  const { title, body, type } = req.body;

  if (!title || !body)
    return res.status(400).json({ message: 'title et body sont requis' });

  const admin = initFirebaseAdmin();

  try {
    const users = await User.find(
      { fcmTokens: { $exists: true, $ne: [] } },
      { fcmTokens: 1 }
    ).lean();

    const tokens = [...new Set(users.flatMap(u => u.fcmTokens || []).filter(Boolean))];
    if (!tokens.length)
      return res.status(200).json({ message: 'Aucun token FCM enregistré', sent: 0 });

    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data        : { type: type || 'GENERAL' },
      android     : {
        priority    : 'high',
        notification: { channelId: 'alertes_generales', sound: 'default' },
      },
      apns: {
        payload: { aps: { sound: 'default' } },
        headers: { 'apns-priority': '10' },
      },
    });

    res.json({
      message: 'Notification envoyée ✅',
      sent   : result.successCount,
      failed : result.failureCount,
    });
  } catch (e) {
    console.error('❌ SEND NOTIF ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur', detail: e.message });
  }
});

module.exports = router;