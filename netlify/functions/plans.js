// POST { idToken, action, tzOffset, ... } -> the signed-in user's weekly protein plan history.
// Actions:
//   "summary"                                -> { streak, sentThisWeek, dots, last, totalWeeks }
//   "record" { target, preferences }         -> same shape as "summary", after saving this week's plan
// We store ONLY what the user typed: weekly protein target, the ranked food names, and when
// they sent the plan. No Kroger product, price, size, or image data is ever saved here
// (Kroger ToS Section 5e). Reordering re-runs the plan builder, so prices are always live.
// One document per calendar week (Monday start, in the user's own timezone), so sending twice
// in one week still counts as one week toward the streak.
const { getAdmin } = require("./_firebaseAdmin");

const WEEK = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 8;
const MAX_WEEKS = 104;
const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Monday 00:00 of the user's local week, returned as a UTC-based timestamp.
function mondayOf(nowMs, tzOffsetMin) {
  const local = new Date(nowMs - tzOffsetMin * 60000);
  const dow = (local.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow);
}
const keyOf = (ms) => new Date(ms).toISOString().slice(0, 10);

async function summarize(col, currentMonday) {
  const snap = await col.orderBy("sentAt", "desc").limit(MAX_WEEKS).get();
  const docs = snap.docs.map((d) => d.data());
  const weeks = new Set(docs.map((d) => d.weekKey));

  // The streak stays alive if this week is done, or if last week was done and this week is still open.
  let start = null;
  if (weeks.has(keyOf(currentMonday))) start = currentMonday;
  else if (weeks.has(keyOf(currentMonday - WEEK))) start = currentMonday - WEEK;
  let streak = 0;
  while (start !== null && weeks.has(keyOf(start - streak * WEEK))) streak++;

  const dots = [];
  for (let i = 7; i >= 0; i--) {
    const key = keyOf(currentMonday - i * WEEK);
    dots.push({ weekKey: key, sent: weeks.has(key) });
  }

  const latest = docs[0] || null;
  return {
    streak,
    sentThisWeek: weeks.has(keyOf(currentMonday)),
    dots,
    totalWeeks: docs.length,
    last: latest
      ? { weekKey: latest.weekKey, sentAt: latest.sentAt, target: latest.target, preferences: latest.preferences }
      : null,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }
  if (!b.idToken) return res(401, { error: "Not signed in" });

  try {
    const admin = getAdmin();
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(b.idToken); }
    catch { return res(401, { error: "Please sign in again." }); }

    const db = admin.firestore();
    const col = db.collection("users").doc(decoded.uid).collection("plans");

    const tz = Number(b.tzOffset);
    const tzOffset = Number.isFinite(tz) ? Math.max(-840, Math.min(840, tz)) : 0;
    const now = Date.now();
    const currentMonday = mondayOf(now, tzOffset);

    if (b.action === "summary") {
      return res(200, await summarize(col, currentMonday));
    }

    if (b.action === "record") {
      const target = Math.round(Number(b.target));
      const preferences = (Array.isArray(b.preferences) ? b.preferences : [])
        .map((p) => clean(p, 60))
        .filter(Boolean)
        .slice(0, MAX_ITEMS);
      if (!target || target <= 0 || target > 100000) return res(400, { error: "Invalid protein target" });
      if (!preferences.length) return res(400, { error: "No protein sources to save" });

      const weekKey = keyOf(currentMonday);
      await col.doc(weekKey).set({ weekKey, sentAt: now, target, preferences });
      return res(200, await summarize(col, currentMonday));
    }

    return res(400, { error: "Unknown action" });
  } catch (e) {
    return res(500, { error: e.message || "Something went wrong with your plan history" });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
