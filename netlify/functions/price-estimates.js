// POST { idToken, locationId, groups: [[name, ...], ...] } -> { groups: [{ total, found, count }] }
// Rough "about $X to buy" totals for several meal ideas in one request, using the store the person picked.
// Live Kroger lookups only. Nothing here is stored. Names are looked up once even if several meals share them.
const admin = require("firebase-admin");
const { searchProducts } = require("./_kroger");

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function init() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  }
  return admin;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad JSON" }); }
  try { init(); await admin.auth().verifyIdToken(String(b.idToken || "")); }
  catch { return json(401, { error: "Sign in first." }); }

  const locationId = String(b.locationId || "");
  if (!/^[A-Za-z0-9]{3,20}$/.test(locationId)) return json(400, { error: "Pick a store first." });
  const groups = (Array.isArray(b.groups) ? b.groups : []).slice(0, 6)
    .map((g) => (Array.isArray(g) ? g : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 8));
  if (!groups.length) return json(400, { error: "Nothing to price." });

  const names = [...new Set(groups.flat().map((n) => n.toLowerCase()))].slice(0, 30);
  const price = new Map();
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const n = names[next++];
      try {
        const p = (await searchProducts(n, locationId))[0]?.items?.[0]?.price;
        const v = p && p.promo > 0 ? p.promo : p?.regular;
        price.set(n, typeof v === "number" ? v : null);
      } catch { price.set(n, null); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  return json(200, {
    groups: groups.map((g) => {
      const got = g.map((n) => price.get(n.toLowerCase())).filter((v) => v != null);
      return { count: g.length, found: got.length, total: Math.round(got.reduce((t, v) => t + v, 0) * 100) / 100 };
    }),
  });
};
