// Lazily-initialized Firebase Admin instance for server-side functions.
// Requires env var FIREBASE_SERVICE_ACCOUNT_JSON: the full service-account JSON
// (Firebase console > Project settings > Service accounts > Generate new private key),
// pasted as a single-line string into the Netlify environment variable.
const admin = require("firebase-admin");

function getAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  return admin;
}

module.exports = { getAdmin };
