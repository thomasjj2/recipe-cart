// POST { ingredients: [{name, qty}], zip } -> { locationId, items: [{ name, qty, product }] }
// Live lookup only — nothing here is stored server-side.
const { searchProducts, findNearestLocation } = require("./_kroger");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }
  const ingredients = Array.isArray(b.ingredients) ? b.ingredients.slice(0, 40) : [];
  if (!ingredients.length) return res(400, { error: "No ingredients to match" });

  try {
    let locationId = null;
    if (b.zip) {
      const loc = await findNearestLocation(String(b.zip).slice(0, 10));
      locationId = loc?.locationId || null;
    }
    const items = [];
    for (const ing of ingredients) {
      const results = await searchProducts(ing.name, locationId);
      const p = results[0];
      items.push({
        name: ing.name,
        qty: ing.qty || "",
        product: p ? {
          upc: p.productId || p.upc,
          description: p.description,
          brand: p.brand,
          price: p.items?.[0]?.price?.regular ?? null,
          promoPrice: p.items?.[0]?.price?.promo ?? null,
          size: p.items?.[0]?.size ?? null,
          image: p.images?.find((i) => i.perspective === "front")?.sizes?.find((s) => s.size === "medium")?.url || null,
        } : null,
      });
    }
    return res(200, { locationId, items });
  } catch (e) {
    return res(500, { error: e.message || "Could not look up products" });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
