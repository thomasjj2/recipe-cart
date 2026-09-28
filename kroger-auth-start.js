// GET /.netlify/functions/kroger-auth-start?idToken=<firebase ID token>
// Verifies the user, then 302s them to Kroger's consent screen with their uid as `state`.
const { getAdmin } = require("./_firebaseAdmin");
const { buildAuthorizeUrl } = require("./_kroger");

exports.handler = async (event) => {
  const idToken = event.queryStringParameters?.idToken;
  if (!idToken) return { statusCode: 400, body: "Missing idToken" };
  try {
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    const url = buildAuthorizeUrl(decoded.uid); // state = uid, checked again on callback
    return { statusCode: 302, headers: { Location: url } };
  } catch (e) {
    return { statusCode: 401, body: "Could not verify your session. Please sign in again." };
  }
};
