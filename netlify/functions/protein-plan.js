// POST { targetProteinPerWeek, preferences: [string,...] ranked highest first, zip, locationId? }
// -> { locationId, targetProteinPerWeek, ranked: PLAN, cheapest: PLAN, comparison }
//    where PLAN = { plan: [...], unmatched: [...], totalProteinEstimate, totalCost, shortfall }
//
// Builds TWO combined plans from ONE set of live Kroger searches (nothing is stored):
//  ranked   walks down the user's preferences in order, using the first search result for each,
//           and buys enough to cover a share of what is still needed.
//  cheapest looks at every search result for every preference, picks the product with the lowest
//           price per gram of protein for each food, then fills the goal from the cheapest food up,
//           still limited to the foods the user listed.
const { searchProducts, findNearestLocation } = require("./_kroger");
const { lookupProtein } = require("./_nutrition");

const LBS_PER_KG = 2.20462;
const MAX_SHARE_PER_ITEM = 0.65; // no single food covers more than 65% of the goal, unless it's the last option left

function parseSizeToLbs(size) {
  if (!size) return null;
  const s = String(size).toLowerCase();
  let lbs = 0, found = false;
  const lbMatch = s.match(/([\d.]+)\s*lb/);
  const ozMatch = s.match(/([\d.]+)\s*oz/);
  const kgMatch = s.match(/([\d.]+)\s*kg/);
  if (lbMatch) { lbs += parseFloat(lbMatch[1]); found = true; }
  if (ozMatch) { lbs += parseFloat(ozMatch[1]) / 16; found = true; }
  if (kgMatch) { lbs += parseFloat(kgMatch[1]) * LBS_PER_KG; found = true; }
  return found && lbs > 0 ? lbs : null;
}

function parseCount(size) {
  if (!size) return null;
  const m = String(size).toLowerCase().match(/(\d+)\s*(ct|count)/);
  if (m) return parseInt(m[1], 10);
  if (/dozen/.test(String(size).toLowerCase())) return 12;
  return null;
}

// How much protein is in ONE package of this product, per its actual unit type.
function proteinPerPackage(nutrition, item) {
  if (!nutrition || !item) return null;
  if (nutrition.unit === "count") {
    const count = parseCount(item.size);
    return count ? count * nutrition.proteinPerUnit : null;
  }
  const lbs = parseSizeToLbs(item.size);
  if (!lbs) return null;
  const grams = lbs * 453.592;
  return (grams / 100) * nutrition.proteinPer100g;
}

const CHEAP_MAX_SHARE = 0.5;      // in cheapest mode no single food covers more than half the goal
const LOW_CONF_MAX_SHARE = 0.3;   // shaky nutrition estimates (canned beans, lentils) get a smaller share
// Skip prepared products when hunting for the lowest price per gram, unless the user asked for them.
const PREPARED = /\b(breaded|fried|battered|nuggets?|patty|patties|meatballs?|stuffed|popcorn|corn dog)\b/i;

const unitPrice = (product) => product?.promoPrice ?? product?.price ?? null;
const round2 = (n) => Math.round(n * 100) / 100;

function toProduct(top, item) {
  return {
    upc: top.productId || top.upc,
    description: top.description,
    brand: top.brand,
    size: item?.size ?? null,
    price: item?.price?.regular ?? null,
    promoPrice: item?.price?.promo ?? null,
    image: top.images?.find((im) => im.perspective === "front")?.sizes?.find((s) => s.size === "medium")?.url || null,
  };
}

function costPer100g(product, perPackage) {
  const price = unitPrice(product);
  return price != null && perPackage ? round2((price / perPackage) * 100) : null;
}

function totals(plan, target, unmatched) {
  const totalProteinEstimate = plan.reduce((s, p) => s + (p.proteinFromThis || 0), 0);
  const totalCost = plan.reduce((s, p) => s + (unitPrice(p.product) ?? 0) * (p.packages || 0), 0);
  return {
    plan,
    unmatched,
    totalProteinEstimate: Math.round(totalProteinEstimate),
    totalCost: round2(totalCost),
    shortfall: Math.round(Math.max(0, target - totalProteinEstimate)),
  };
}

// Ranked: same behavior as before. First search result for each preference, in the user's order.
function buildRanked(entries, target) {
  const plan = [], skipped = [];
  let remaining = target;
  for (const e of entries) {
    if (remaining <= 0) break; // goal already met by earlier picks
    const top = e.matches[0] || null;
    if (!top) { skipped.push({ rank: e.rank, name: e.name, reason: "not_carried" }); continue; }

    const item = top.items?.[0];
    const perPackage = proteinPerPackage(e.nutrition, item);
    const product = toProduct(top, item);

    if (!perPackage) {
      plan.push({
        rank: e.rank, name: e.name, product, packages: null, proteinFromThis: null,
        note: "Couldn't determine a reliable quantity for this item.",
        wasFallback: skipped.length > 0 && plan.length === 0,
      });
      continue;
    }

    const amountToCover = Math.min(remaining, target * MAX_SHARE_PER_ITEM);
    const packages = Math.max(1, Math.ceil(amountToCover / perPackage));
    const proteinFromThis = packages * perPackage;
    plan.push({
      rank: e.rank, name: e.name, product, packages,
      proteinFromThis: Math.round(proteinFromThis),
      costPer100gProtein: costPer100g(product, perPackage),
      confidence: e.nutrition?.confidence || null,
      assumptionNote: e.nutrition?.note || null,
      wasFallback: skipped.length > 0 && plan.length === 0,
    });
    remaining -= proteinFromThis;
  }
  return totals(plan, target, skipped);
}

// Cheapest: best price per gram of protein among ALL search results for each listed food.
function buildCheapest(entries, target) {
  const candidates = [], skipped = [];
  for (const e of entries) {
    if (!e.matches.length) { skipped.push({ rank: e.rank, name: e.name, reason: "not_carried" }); continue; }
    if (!e.nutrition) { skipped.push({ rank: e.rank, name: e.name, reason: "no_estimate" }); continue; }
    const askedForPrepared = PREPARED.test(e.name);
    let best = null;
    for (const top of e.matches) {
      if (!askedForPrepared && PREPARED.test(top.description || "")) continue;
      const item = top.items?.[0];
      const perPackage = proteinPerPackage(e.nutrition, item);
      const product = toProduct(top, item);
      const price = unitPrice(product);
      if (!perPackage || price == null || price <= 0) continue;
      const cpg = price / perPackage;
      if (!best || cpg < best.cpg) best = { product, perPackage, cpg };
    }
    if (!best) { skipped.push({ rank: e.rank, name: e.name, reason: "no_estimate" }); continue; }
    candidates.push({ ...e, ...best });
  }
  candidates.sort((a, b) => a.cpg - b.cpg);

  const plan = [];
  let remaining = target;
  for (const c of candidates) {
    if (remaining <= 0) break;
    const share = c.nutrition.confidence === "low" ? LOW_CONF_MAX_SHARE : CHEAP_MAX_SHARE;
    const amountToCover = Math.min(remaining, target * share);
    let packages = Math.max(1, Math.ceil(amountToCover / c.perPackage));
    // Avoid buying a whole extra package for a small gap: settle for 90% of the amount if it saves one.
    const fewer = packages - 1;
    if (fewer >= 1 && fewer * c.perPackage >= amountToCover * 0.9) packages = fewer;
    const proteinFromThis = packages * c.perPackage;
    plan.push({
      rank: c.rank, name: c.name, product: c.product, packages,
      proteinFromThis: Math.round(proteinFromThis),
      costPer100gProtein: costPer100g(c.product, c.perPackage),
      confidence: c.nutrition.confidence || null,
      assumptionNote: c.nutrition.note || null,
      wasFallback: false,
    });
    remaining -= proteinFromThis;
  }
  return totals(plan, target, skipped);
}

const signature = (p) => p.plan.map((x) => `${x.product?.upc}:${x.packages}`).sort().join("|");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }
  const target = Number(b.targetProteinPerWeek);
  const preferences = Array.isArray(b.preferences) ? b.preferences.filter(Boolean).slice(0, 8) : [];
  if (!target || target <= 0) return res(400, { error: "Enter a weekly protein target in grams" });
  if (!preferences.length) return res(400, { error: "Add at least one preferred protein source" });

  try {
    let locationId = b.locationId || null;
    if (!locationId && b.zip) {
      const loc = await findNearestLocation(String(b.zip).slice(0, 10));
      locationId = loc?.locationId || null;
    }

    // One live search per food. Both plans are built from these same results.
    const entries = await Promise.all(preferences.map(async (name, i) => ({
      rank: i + 1,
      name,
      nutrition: lookupProtein(name),
      matches: await searchProducts(name, locationId),
    })));

    const ranked = buildRanked(entries, target);
    const cheapest = buildCheapest(entries, target);

    // Only call the cheapest plan "cheaper" when it also covers about the same amount of protein.
    const comparable = cheapest.totalProteinEstimate >= ranked.totalProteinEstimate * 0.95;
    const comparison = {
      same: signature(ranked) === signature(cheapest),
      comparable,
      savings: comparable ? round2(ranked.totalCost - cheapest.totalCost) : 0,
    };

    return res(200, { locationId, targetProteinPerWeek: target, ranked, cheapest, comparison });
  } catch (e) {
    return res(500, { error: e.message || "Could not build your protein plan" });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
