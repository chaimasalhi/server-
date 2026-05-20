const admin = require('firebase-admin');
const fs = require('fs');

function initFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!serviceAccountPath) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH manquant (chemin du JSON service account Firebase)');
  }
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Fichier service account introuvable: ${serviceAccountPath}`);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

module.exports = { initFirebaseAdmin };

