// GET /.netlify/functions/kroger-auth-callback?code=...&state=<uid>
// Kroger redirects here after the user approves cart access. We exchange the code
// for tokens, store ONLY the refresh token (server-side, per user), and send them
// back into the app. We never store Kroger's product/price content here — just the
// credential needed to act on the user's own cart on their behalf.
const { getAdmin } = require("./_firebaseAdmin");
const { exchangeCode } = require("./_kroger");

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};
  const appUrl = process.env.APP_URL || "/";
  if (error) return redirect(appUrl, "kroger_denied");
  if (!code || !state) return redirect(appUrl, "kroger_error");

  try {
    const tokens = await exchangeCode(code);
    const db = getAdmin().firestore();
    await db.collection("users").doc(state).set(
      { kroger: { refreshToken: tokens.refresh_token, connectedAt: Date.now() } },
      { merge: true }
    );
    return redirect(appUrl, "kroger_connected");
  } catch (e) {
    return redirect(appUrl, "kroger_error");
  }
};

const redirect = (base, flag) => ({ statusCode: 302, headers: { Location: `${base}?${flag}=1` } });
