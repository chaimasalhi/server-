const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User           = require('../models/User');

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/auth/google/callback',
},
async (accessToken, refreshToken, profile, done) => {
  console.log('🔍 Google OAuth — profile reçu:', profile.id, profile.emails?.[0]?.value);

  try {
    // ── 1. Chercher par googleId ────────────────────────
    let user = await User.findOne({ googleId: profile.id });
    console.log('👤 User trouvé par googleId:', user ? `OUI (${user.email})` : 'NON');

    if (!user) {
      // ── 2. Chercher par email (compte existant sans Google) ──
      user = await User.findOne({ email: profile.emails?.[0]?.value });
      console.log('📧 User trouvé par email:', user ? `OUI (${user.email})` : 'NON');

      if (user) {
        // Lier le googleId au compte existant
        user.googleId    = profile.id;
        user.accessToken = accessToken;
        user.avatar      = profile.photos?.[0]?.value || user.avatar;
        await user.save();
        console.log('🔗 GoogleId lié au compte existant:', user.email, '| role:', user.role);
      } else {
        // ── 3. Créer un nouveau compte ──────────────────
        user = await User.create({
          googleId   : profile.id,
          email      : profile.emails?.[0]?.value,
          nom        : profile.name?.familyName  || '',
          prenom     : profile.name?.givenName   || '',
          avatar     : profile.photos?.[0]?.value || '',
          accessToken,
          role       : 'employe',   // ✅ Rôle par défaut obligatoire
          isApproved : true,        // Google = compte vérifié directement
        });
        console.log('✅ Nouveau user créé:', user.email, '| role:', user.role);
      }
    } else {
      // Mettre à jour le token si l'user existe déjà
      user.accessToken = accessToken;
      if (profile.photos?.[0]?.value) user.avatar = profile.photos[0].value;
      await user.save();
    }

    // Vérification finale
    if (!user.role) {
      console.warn('⚠️  User sans role détecté, correction en employe:', user.email);
      user.role = 'employe';
      await user.save();
    }

    console.log('🎫 Auth Google OK — email:', user.email, '| role:', user.role, '| isApproved:', user.isApproved);
    return done(null, user);

  } catch (err) {
    console.error('❌ Passport Google ERROR:', err.message, err);
    return done(err, null);
  }
}));

module.exports = passport;