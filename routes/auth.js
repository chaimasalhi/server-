const router     = require('express').Router();
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const User       = require('../models/User'); 
const { auth, isAdmin } = require('../config/middleware/authMiddleware');
const passport   = require('passport');
require('../config/passport');

// ══════════════════════════════════════════════════════════
//  🔐 ADMIN HARDCODED — Chef Informatique OMMP
// ══════════════════════════════════════════════════════════
const ADMIN = {
  email   : process.env.ADMIN_EMAIL    || 'admin@ommp.tn',
  password: process.env.ADMIN_PASSWORD || 'AdminOMMP2024!',
  nom     : process.env.ADMIN_NOM      || 'Chef',
  prenom  : process.env.ADMIN_PRENOM   || 'Informatique',
};

// ─── Config Nodemailer Gmail ───────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
});

// Store temporaire reset codes (en mémoire)
const resetStore = new Map();

// ══════════════════════════════════════════════════════════
//  POST /api/auth/login
// ══════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const cleanEmail = email?.trim().toLowerCase();

  if (!cleanEmail || !password)
    return res.status(400).json({ message: 'Email et mot de passe requis' });

  try {
    // ── 1. Admin hardcoded ─────────────────────────────────
    if (cleanEmail === ADMIN.email.toLowerCase()) {
      if (password !== ADMIN.password)
        return res.status(400).json({ message: 'Mot de passe administrateur incorrect' });

      const token = jwt.sign(
        {
          id    : 'admin_hardcoded',
          role  : 'admin',
          nom   : ADMIN.nom,
          prenom: ADMIN.prenom,
          email : ADMIN.email,
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );
      return res.json({
        token,
        user: {
          id    : 'admin_hardcoded',
          email : ADMIN.email,
          role  : 'admin',
          nom   : ADMIN.nom,
          prenom: ADMIN.prenom,
        },
      });
    }

    // ── 2. Technicien / Employé depuis DB ──────────────────
    const user = await User.findOne({ email: cleanEmail });

    if (!user)
      return res.status(400).json({ message: 'Utilisateur introuvable' });

    if (!user.isApproved)
      return res.status(403).json({
        message: "Votre compte est en attente d'approbation par le chef informatique. Veuillez patienter.",
      });

    if (!user.password)
      return res.status(400).json({ message: 'Connexion via Google uniquement pour ce compte' });

    if (!await bcrypt.compare(password, user.password))
      return res.status(400).json({ message: 'Mot de passe incorrect' });

    // ✅ Vérification du rôle avant signature JWT
    if (!user.role) {
      console.warn('⚠️  Rôle manquant pour:', user.email, '→ employe par défaut');
      user.role = 'employe';
      await user.save();
    }

    const token = jwt.sign(
      {
        id    : user._id,
        role  : user.role,
        nom   : user.nom,
        prenom: user.prenom,
        email : user.email,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id    : user._id,
        email : user.email,
        role  : user.role,
        nom   : user.nom,
        prenom: user.prenom,
      },
    });

  } catch (e) {
    console.error('❌ LOGIN ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/auth/register
//  ❌ Admin ne peut PAS s'inscrire
//  ✅ Compte créé avec isApproved: false → attente admin
// ══════════════════════════════════════════════════════════
router.post('/register', async (req, res) => {
  const { nom, prenom, email, password, role } = req.body;

  if (!nom || !prenom || !email || !password || !role)
    return res.status(400).json({ message: 'Tous les champs sont requis' });

  if (role === 'admin')
    return res.status(403).json({ message: "L'inscription en tant qu'administrateur est interdite." });

  const rolesAutorises = ['technicien', 'employe'];
  if (!rolesAutorises.includes(role))
    return res.status(400).json({ message: 'Rôle invalide. Choisir : technicien ou employe' });

  try {
    const cleanEmail = email.trim().toLowerCase();

    if (cleanEmail === ADMIN.email.toLowerCase())
      return res.status(400).json({ message: 'Email déjà utilisé' });

    const existing = await User.findOne({ email: cleanEmail });
    if (existing)
      return res.status(400).json({ message: 'Email déjà utilisé' });

    const hashed = await bcrypt.hash(password, 10);
    await User.create({
      nom,
      prenom,
      email     : cleanEmail,
      password  : hashed,
      role,
      isApproved: false,
    });

    console.log(`📝 Nouveau compte en attente : ${cleanEmail} (${role})`);
    res.status(201).json({
      message: "Compte créé avec succès. En attente d'approbation par le chef informatique.",
    });

  } catch (e) {
    console.error('❌ REGISTER ERROR:', e);
    res.status(500).json({ message: 'Erreur serveur', detail: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/auth/me
// ══════════════════════════════════════════════════════════
router.get('/me', auth, async (req, res) => {
  try {
    if (req.user.id === 'admin_hardcoded') {
      return res.json({
        id    : 'admin_hardcoded',
        email : ADMIN.email,
        role  : 'admin',
        nom   : ADMIN.nom,
        prenom: ADMIN.prenom,
      });
    }
    const user = await User.findById(req.user.id, '-password -accessToken');
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/auth/pending  — Comptes en attente (Admin)
// ══════════════════════════════════════════════════════════
router.get('/pending', auth, isAdmin, async (req, res) => {
  try {
    const users = await User.find({ isApproved: false }, '-password -accessToken')
      .sort({ createdAt: -1 });
    res.json(users);
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/auth/users  — Tous les utilisateurs (Admin)
// ══════════════════════════════════════════════════════════
router.get('/users', auth, isAdmin, async (req, res) => {
  try {
    const users = await User.find({}, '-password -accessToken').sort({ createdAt: -1 });
    res.json(users);
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/auth/users/:id  — Détail utilisateur (Admin)
// ══════════════════════════════════════════════════════════
router.get('/users/:id', auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id, '-password -accessToken');
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  PUT /api/auth/users/:id  — Modifier utilisateur (Admin)
// ══════════════════════════════════════════════════════════
router.put('/users/:id', auth, isAdmin, async (req, res) => {
  try {
    const { role, nom, prenom, isApproved } = req.body;

    if (role && !['technicien', 'employe'].includes(role))
      return res.status(400).json({ message: 'Rôle invalide' });

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { role, nom, prenom, isApproved },
      { new: true, select: '-password -accessToken' }
    );
    if (!updated) return res.status(404).json({ message: 'Utilisateur introuvable' });
    res.json({ message: 'Utilisateur modifié ✅', user: updated });
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/auth/users/:id  — Supprimer (Admin)
// ══════════════════════════════════════════════════════════
router.delete('/users/:id', auth, isAdmin, async (req, res) => {
  try {
    const deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Utilisateur introuvable' });
    res.json({ message: 'Utilisateur supprimé ✅' });
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  PUT /api/auth/approve/:id  — Approuver (Admin)
// ══════════════════════════════════════════════════════════
router.put('/approve/:id', auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isApproved: true },
      { new: true, select: '-password -accessToken' }
    );
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });
    console.log(`✅ Compte approuvé : ${user.email}`);
    res.json({ message: `Compte de ${user.prenom} ${user.nom} approuvé ✅`, user });
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  PUT /api/auth/reject/:id  — Désactiver (Admin)
// ══════════════════════════════════════════════════════════
router.put('/reject/:id', auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isApproved: false },
      { new: true, select: '-password -accessToken' }
    );
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });
    res.json({ message: 'Compte désactivé ✅', user });
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/auth/stats  — Statistiques (Admin)
// ══════════════════════════════════════════════════════════
router.get('/stats', auth, isAdmin, async (req, res) => {
  try {
    const total       = await User.countDocuments();
    const techniciens = await User.countDocuments({ role: 'technicien' });
    const employes    = await User.countDocuments({ role: 'employe' });
    const approuves   = await User.countDocuments({ isApproved: true });
    const enAttente   = await User.countDocuments({ isApproved: false });
    res.json({
      total,
      parRole: { admin: 1, technicien: techniciens, employe: employes },
      approuves,
      enAttente,
    });
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  PUT /api/auth/change-password
// ══════════════════════════════════════════════════════════
router.put('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!newPassword || newPassword.length < 8)
    return res.status(400).json({ message: 'Mot de passe trop court (min. 8 car.)' });

  if (req.user.id === 'admin_hardcoded')
    return res.status(403).json({
      message: 'Modifiez le mot de passe admin directement dans le fichier .env',
    });

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });

    if (user.password) {
      if (!currentPassword)
        return res.status(400).json({ message: 'Ancien mot de passe requis' });
      if (!await bcrypt.compare(currentPassword, user.password))
        return res.status(400).json({ message: 'Ancien mot de passe incorrect' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ message: 'Mot de passe modifié ✅' });
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/auth/forgot-password
// ══════════════════════════════════════════════════════════
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email requis' });

  if (email.trim().toLowerCase() === ADMIN.email.toLowerCase())
    return res.json({ message: 'Si cet email existe, un code a été envoyé.' });

  try {
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) return res.json({ message: 'Si cet email existe, un code a été envoyé.' });

    const code      = Math.floor(100000 + Math.random() * 900000).toString();
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 min
    resetStore.set(email.trim().toLowerCase(), { code, token, expiresAt });

    const resetLink = `${process.env.CLIENT_URL}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;
    await transporter.sendMail({
      from   : `"OMMP NetTemp Guard" <${process.env.GMAIL_USER}>`,
      to     : email,
      subject: '🔐 Réinitialisation de votre mot de passe — OMMP',
      html   : `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px;">
          <h2 style="color:#4A6CF7;">OMMP NetTemp Guard</h2>
          <p>Votre code de réinitialisation :</p>
          <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#4A6CF7;margin:20px 0;">${code}</div>
          <p style="color:#888;font-size:13px;">Ce code est valable <strong>15 minutes</strong>.</p>
          <hr/>
          <p>Ou cliquez sur ce lien : <a href="${resetLink}">Réinitialiser mon mot de passe</a></p>
          <p style="color:#aaa;font-size:11px;">Si vous n'avez pas fait cette demande, ignorez cet email.</p>
        </div>
      `,
    });

    console.log(`📧 Code reset envoyé à : ${email}`);
    res.json({ message: 'Code envoyé par email ✅' });

  } catch (e) {
    console.error('❌ FORGOT PASSWORD ERROR:', e);
    res.status(500).json({ message: 'Erreur envoi email', detail: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/auth/verify-code
// ══════════════════════════════════════════════════════════
router.post('/verify-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code)
    return res.status(400).json({ message: 'Email et code requis' });

  const entry = resetStore.get(email.trim().toLowerCase());
  if (!entry)
    return res.status(400).json({ message: 'Aucune demande trouvée.' });
  if (Date.now() > entry.expiresAt)
    return res.status(400).json({ message: 'Code expiré.' });
  if (entry.code !== code.trim())
    return res.status(400).json({ message: 'Code incorrect.' });

  res.json({ message: 'Code vérifié ✅', token: entry.token });
});

// ══════════════════════════════════════════════════════════
//  POST /api/auth/reset-password
// ══════════════════════════════════════════════════════════
router.post('/reset-password', async (req, res) => {
  const { email, token, password } = req.body;

  if (!email || !token || !password)
    return res.status(400).json({ message: 'Données manquantes' });
  if (password.length < 8)
    return res.status(400).json({ message: 'Mot de passe trop court' });

  const entry = resetStore.get(email.trim().toLowerCase());
  if (!entry || Date.now() > entry.expiresAt || entry.token !== token)
    return res.status(400).json({ message: 'Lien expiré ou invalide' });

  try {
    const hashed = await bcrypt.hash(password, 10);
    await User.findOneAndUpdate(
      { email: email.trim().toLowerCase() },
      { password: hashed }
    );
    resetStore.delete(email.trim().toLowerCase());
    console.log(`🔑 Mot de passe réinitialisé pour : ${email}`);
    res.json({ message: 'Mot de passe réinitialisé ✅' });
  } catch (e) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════
//  Google OAuth — Initiation
// GET /api/auth/google
router.get('/google', (req, res, next) => {
  // Le front passe son URL via ?redirect=
  const redirectOrigin = req.query.redirect || process.env.CLIENT_URL;
  
  // Stocker dans la session / state OAuth
  req.session = req.session || {};
  
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
    state: Buffer.from(redirectOrigin).toString('base64'), // encoder l'origine
  })(req, res, next);
});

// GET /api/auth/google/callback
router.get('/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${process.env.CLIENT_URL}/login?error=google_failed`,
  }),
  (req, res) => {
    try {
      const user = req.user;
      if (!user) return res.redirect(`${process.env.CLIENT_URL}/login?error=user_null`);

      const token = jwt.sign(
        { id: user._id, role: user.role, nom: user.nom, prenom: user.prenom, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      // ✅ Récupérer l'origine depuis le state OAuth
      let clientUrl = process.env.CLIENT_URL;
      try {
        if (req.query.state) {
          clientUrl = Buffer.from(req.query.state, 'base64').toString('utf8');
        }
      } catch (_) {}

      // ✅ Whitelist de sécurité — autoriser seulement vos deux frontends
      const allowedOrigins = [
        'http://localhost:5173',   // Vite
        'http://localhost:8080',   // Flutter Web
        'http://localhost:3000',   // fallback
        process.env.CLIENT_URL,
      ];

      if (!allowedOrigins.includes(clientUrl)) {
        clientUrl = process.env.CLIENT_URL; // fallback sécurisé
      }

      console.log(`✅ Google login OK — ${user.email} | redirect → ${clientUrl}`);
      res.redirect(`${clientUrl}/auth/callback?token=${token}`);

    } catch (e) {
      console.error('❌ Google callback ERROR:', e);
      res.redirect(`${process.env.CLIENT_URL}/login?error=server_error`);
    }
  }

);

module.exports = router;