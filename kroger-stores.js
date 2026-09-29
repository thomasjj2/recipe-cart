// POST { zip } -> { stores: [{ locationId, name, address }] }
// Deliberately self-contained (own token fetch) rather than importing from _kroger.js,
// so this new feature can't affect any existing, working Kroger integration.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }
  const zip = String(b.zip || "").trim().slice(0, 10);
  if (!zip) return res(400, { error: "Enter a ZIP code" });

  const id = process.env.KROGER_CLIENT_ID;
  const secret = process.env.KROGER_CLIENT_SECRET;
  if (!id || !secret) return res(500, { error: "Missing Kroger credentials" });

  try {
    const basic = Buffer.from(`${id}:${secret}`).toString("base64");
    const tokenRes = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
      body: "grant_type=client_credentials&scope=product.compact",
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) return res(502, { error: tokenData.error_description || "Kroger auth error" });

    const params = new URLSearchParams({ "filter.zipCode.near": zip, "filter.limit": "7" });
    const locRes = await fetch(`https://api.kroger.com/v1/locations?${params}`, {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });
    const locData = await locRes.json();
    if (!locRes.ok) return res(502, { error: locData.errors?.[0]?.reason || "Kroger location search error" });

    const stores = (locData.data || []).map((l) => ({
      locationId: l.locationId,
      name: l.name || l.chain,
      address: [l.address?.addressLine1, l.address?.city, l.address?.state].filter(Boolean).join(", "),
    }));
    return res(200, { stores });
  } catch (e) {
    return res(500, { error: "Could not find stores near that ZIP" });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
