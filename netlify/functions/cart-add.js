// POST { idToken, items: [{ upc, quantity }] } -> adds items to the user's real Kroger cart
const { getAdmin } = require("./_firebaseAdmin");
const { refreshUserToken, addToCart } = require("./_kroger");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }
  if (!b.idToken) return res(401, { error: "Not signed in" });
  const items = (b.items || []).filter((i) => i.upc);
  if (!items.length) return res(400, { error: "No items to add" });

  try {
    const admin = getAdmin();
    const decoded = await admin.auth().verifyIdToken(b.idToken);
    const db = admin.firestore();
    const doc = await db.collection("users").doc(decoded.uid).get();
    const refreshToken = doc.data()?.kroger?.refreshToken;
    if (!refreshToken) return res(409, { error: "not_connected" });

    const fresh = await refreshUserToken(refreshToken);
    // Kroger rotates refresh tokens on use — save the new one.
    if (fresh.refresh_token && fresh.refresh_token !== refreshToken) {
      await db.collection("users").doc(decoded.uid).set(
        { kroger: { refreshToken: fresh.refresh_token, connectedAt: Date.now() } },
        { merge: true }
      );
    }
    await addToCart(fresh.access_token, items);
    return res(200, { added: items.length });
  } catch (e) {
    return res(500, { error: e.message || "Could not add items to your cart" });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
