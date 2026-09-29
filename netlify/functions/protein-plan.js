// POST { targetProteinPerWeek, preferences: [string,...] ranked highest first, zip, locationId? }
// -> { locationId, targetProteinPerWeek, plan: [...], totalProteinEstimate, totalCost, shortfall, unmatched: [...] }
//
// Builds ONE combined plan across the ranked list (not independent single-food options):
// walks down the preferences in order, and for each carried item, buys enough to cover
// a share of what's still needed, then moves to the next preference for the remainder —
// the way someone would actually assemble a week's shopping from a few different foods.
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

    const plan = [];       // items actually selected for the combined plan
    const skipped = [];    // preferences that weren't carried, for fallback narration
    let remaining = target;
    let rank = 0;

    for (const name of preferences) {
      rank++;
      if (remaining <= 0) break; // goal already met by earlier picks — stop, don't force extra items

      const matches = await searchProducts(name, locationId);
      const top = matches[0] || null;
      if (!top) {
        skipped.push({ rank, name, reason: "not_carried" });
        continue;
      }

      const item = top.items?.[0];
      const nutrition = lookupProtein(name);
      const perPackage = proteinPerPackage(nutrition, item);

      const product = {
        upc: top.productId || top.upc,
        description: top.description,
        brand: top.brand,
        size: item?.size ?? null,
        price: item?.price?.regular ?? null,
        promoPrice: item?.price?.promo ?? null,
        image: top.images?.find((im) => im.perspective === "front")?.sizes?.find((s) => s.size === "medium")?.url || null,
      };

      if (!perPackage) {
        // We found the product, but can't confidently size it — include it as
        // informational only, don't let it silently count toward the goal.
        plan.push({
          rank, name, product, packages: null, proteinFromThis: null,
          note: "Couldn't determine a reliable quantity for this item.",
          wasFallback: skipped.length > 0 && plan.length === 0,
        });
        continue;
      }

      const cap = target * MAX_SHARE_PER_ITEM;
      const amountToCover = Math.min(remaining, cap);
      const packages = Math.max(1, Math.ceil(amountToCover / perPackage));
      const proteinFromThis = packages * perPackage;

      plan.push({
        rank, name, product, packages,
        proteinFromThis: Math.round(proteinFromThis),
        confidence: nutrition?.confidence || null,
        assumptionNote: nutrition?.note || null,
        wasFallback: skipped.length > 0 && plan.length === 0,
      });
      remaining -= proteinFromThis;
    }

    const totalProteinEstimate = plan.reduce((s, p) => s + (p.proteinFromThis || 0), 0);
    const totalCost = plan.reduce((s, p) => {
      const unitPrice = p.product?.promoPrice ?? p.product?.price ?? 0;
      return s + unitPrice * (p.packages || 0);
    }, 0);
    const shortfall = Math.max(0, target - totalProteinEstimate);

    return res(200, {
      locationId,
      targetProteinPerWeek: target,
      plan,
      unmatched: skipped,
      totalProteinEstimate: Math.round(totalProteinEstimate),
      totalCost: Math.round(totalCost * 100) / 100,
      shortfall: Math.round(shortfall),
    });
  } catch (e) {
    return res(500, { error: e.message || "Could not build your protein plan" });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
