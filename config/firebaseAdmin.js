const admin = require('firebase-admin');

function initFirebaseAdmin() {
  if (admin.apps.length) return admin;

  // 1. Récupérer les variables d'environnement
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  // 2. Vérifier qu'elles existent
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Variables Firebase manquantes : FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY'
    );
  }

  // 3. Corriger les retours à la ligne dans la clé privée
  privateKey = privateKey.replace(/\\n/g, '\n');

  // 4. Construire l'objet service account
  const serviceAccount = {
    projectId,
    clientEmail,
    privateKey,
  };

  // 5. Initialiser Firebase Admin
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

module.exports = { initFirebaseAdmin };

