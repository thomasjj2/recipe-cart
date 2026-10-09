// Finds one Unsplash photo for a meal name. GET /.netlify/functions/meal-photo?q=teriyaki chicken bowl
// Also reports a photo as used (Unsplash API guideline): GET /.netlify/functions/meal-photo?dl=<download_location>
// Needs the UNSPLASH_ACCESS_KEY environment variable (the "Access Key" of your Unsplash developer app).
const memo = new Map(); // warm instance cache, saves repeat calls to Unsplash
const UTM = "?utm_source=recipe_cart&utm_medium=referral";

const clean = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

async function search(q, key) {
  const url = "https://api.unsplash.com/search/photos?" + new URLSearchParams({ query: q, per_page: "10", orientation: "landscape", content_filter: "high" });
  const r = await fetch(url, { headers: { Authorization: "Client-ID " + key, "Accept-Version": "v1" } });
  if (r.status === 403 || r.status === 429) { const e = new Error("Photo limit reached. Try again later."); e.status = 429; throw e; }
  if (!r.ok) { const e = new Error("Photo search failed."); e.status = 502; throw e; }
  const d = await r.json();
  const photos = Array.isArray(d.results) ? d.results : [];
  if (!photos.length) return null;
  // Stock photo search can drift, so prefer the photo whose description mentions the most words from the meal name.
  const words = q.split(" ").filter((w) => w.length > 3 && w !== "food");
  let best = photos[0], bestScore = -1;
  for (const p of photos) {
    const text = clean((p.alt_description || "") + " " + (p.description || ""));
    const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  const user = best.user || {};
  return {
    url: best.urls && best.urls.small,
    by: user.name || "",
    link: user.links && user.links.html ? user.links.html + UTM : "",
    dl: (best.links && best.links.download_location) || "",
  };
}

exports.handler = async (event) => {
  const json = (status, body, cache) => ({
    statusCode: status,
    headers: { "content-type": "application/json", ...(cache ? { "cache-control": "public, max-age=604800" } : {}) },
    body: JSON.stringify(body),
  });
  if (event.httpMethod !== "GET") return json(405, { error: "Use GET." });
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return json(500, { error: "Photos are not set up." });
  const dl = event.queryStringParameters && event.queryStringParameters.dl;
  if (dl) {
    // Tells Unsplash a photo was used, so the photographer gets credit. Only real Unsplash download links are accepted.
    if (!/^https:\/\/api\.unsplash\.com\/photos\/[A-Za-z0-9_-]+\/download(\?ixid=[A-Za-z0-9_=-]+)?$/.test(dl)) return json(400, { error: "Bad link." });
    try { await fetch(dl, { headers: { Authorization: "Client-ID " + key, "Accept-Version": "v1" } }); } catch {}
    return json(200, { ok: true });
  }
  const q = clean(event.queryStringParameters && event.queryStringParameters.q);
  if (!q) return json(400, { error: "Missing meal name." });
  if (memo.has(q)) return json(200, memo.get(q), true);
  try {
    let hit = await search(q + " food", key);
    if (!hit) hit = await search(q.split(" ").slice(-2).join(" ") + " food", key);
    const out = hit && hit.url ? hit : { url: null };
    memo.set(q, out);
    if (memo.size > 500) memo.delete(memo.keys().next().value);
    return json(200, out, true);
  } catch (e) {
    return json(e.status || 502, { error: e.message || "Photo search failed." });
  }
};
