const jwt = require('jsonwebtoken');

// ══════════════════════════════════════════════════════════
//  Vérifie que l'utilisateur est connecté (token valide)
// ══════════════════════════════════════════════════════════
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token)
    return res.status(401).json({ message: 'Token manquant' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Token invalide ou expiré' });
  }
};

// ══════════════════════════════════════════════════════════
//  Vérifie que l'utilisateur est ADMIN
// ══════════════════════════════════════════════════════════
const isAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin')
    return res.status(403).json({ message: 'Accès refusé : administrateur requis' });
  next();
};

// ══════════════════════════════════════════════════════════
//  Vérifie que l'utilisateur est ADMIN ou TECHNICIEN
// ══════════════════════════════════════════════════════════
const isAdminOrTech = (req, res, next) => {
  if (!['admin', 'technicien'].includes(req.user?.role))
    return res.status(403).json({ message: 'Accès refusé : admin ou technicien requis' });
  next();
};

module.exports = { auth, isAdmin, isAdminOrTech };