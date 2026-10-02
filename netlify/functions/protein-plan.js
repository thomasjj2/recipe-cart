// POST { goal: "protein"|"calories"|"both", targetProteinPerWeek, targetCaloriesPerDay, preferences: [string,...] ranked highest first, zip, locationId? }
// Calories goal derives a protein floor (25 percent of calories from protein). Both goals run protein first, then top up calories with the cheapest calories among the listed foods.
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
  const flMatch = s.match(/([\d.]+)\s*fl\s*oz/);
  if (flMatch) { lbs += (parseFloat(flMatch[1]) * 0.95) / 16; found = true; }
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

// How much protein or calories is in ONE package of this product, per its actual unit type.
function amountPerPackage(nutrition, item, metric) {
  if (!nutrition || !item) return null;
  const cal = metric === "calories";
  if (nutrition.unit === "count") {
    const count = parseCount(item.size);
    const per = cal ? nutrition.caloriesPerUnit : nutrition.proteinPerUnit;
    return count && per != null ? count * per : null;
  }
  const lbs = parseSizeToLbs(item.size);
  const per = cal ? nutrition.caloriesPer100g : nutrition.proteinPer100g;
  if (!lbs || per == null) return null;
  return ((lbs * 453.592) / 100) * per;
}
const proteinPerPackage = (nutrition, item) => amountPerPackage(nutrition, item, "protein");

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
    if (e.nutrition && e.nutrition.proteinPer100g === 0) continue; // calorie only foods are added in the calorie top up
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
    if (e.nutrition.proteinPer100g === 0) continue; // calorie only foods are added in the calorie top up
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

const CAL_SHARE = 0.6; // no single food covers more than 60% of the calorie goal

function annotate(plan) {
  for (const p of plan) {
    if (!p.packages) continue;
    const cp = amountPerPackage(lookupProtein(p.name), { size: p.product?.size }, "calories");
    p.caloriesFromThis = cp ? Math.round(p.packages * cp) : null;
  }
}

function bestForCalories(e) {
  const askedPrepared = PREPARED.test(e.name);
  let best = null;
  for (const top of e.matches) {
    if (!askedPrepared && PREPARED.test(top.description || "")) continue;
    const item = top.items?.[0];
    const perCal = amountPerPackage(e.nutrition, item, "calories");
    const product = toProduct(top, item);
    const price = unitPrice(product);
    if (!perCal || price == null || price <= 0) continue;
    const cpc = price / perCal;
    if (!best || cpc < best.cpc) best = { product, perCal, cpc };
  }
  return best;
}

// Adds the cheapest calories among the listed foods until the weekly calorie goal is covered.
function topUpCalories(v, entries, calTarget) {
  const cands = [];
  for (const e of entries) {
    if (!e.nutrition || !e.matches.length) continue;
    const best = bestForCalories(e);
    if (best) cands.push({ ...e, ...best });
  }
  cands.sort((a, b) => a.cpc - b.cpc);
  let have = v.plan.reduce((s, p) => s + (p.caloriesFromThis || 0), 0);
  for (const c of cands) {
    if (have >= calTarget) break;
    let line = v.plan.find((p) => p.packages && p.name === c.name && p.product?.upc === c.product.upc);
    const already = line?.caloriesFromThis || 0;
    const need = Math.min(calTarget - have, calTarget * CAL_SHARE - already);
    if (need <= 0) continue;
    const add = Math.max(1, Math.ceil(need / c.perCal));
    if (line) line.packages += add;
    else {
      line = { rank: c.rank, name: c.name, product: c.product, packages: add, confidence: c.nutrition.confidence || null,
        assumptionNote: c.nutrition.note || null, wasFallback: false, addedForCalories: true };
      v.plan.push(line);
    }
    const pp = amountPerPackage(c.nutrition, { size: c.product.size }, "protein");
    if (pp != null) line.proteinFromThis = Math.round(line.packages * pp);
    line.caloriesFromThis = Math.round(line.packages * c.perCal);
    line.costPer100gProtein = pp ? costPer100g(line.product, pp) : null;
    have += add * c.perCal;
  }
}

// Staples picked for protein (like rice) can overshoot calories. Drop the priciest package while both goals stay within 5 percent.
function trimExtras(v, proteinTarget, calTarget) {
  for (;;) {
    const prot = v.plan.reduce((s, p) => s + (p.proteinFromThis || 0), 0);
    const cal = v.plan.reduce((s, p) => s + (p.caloriesFromThis || 0), 0);
    const opts = v.plan.filter((p) => {
      if (!p.packages || !p.caloriesFromThis) return false;
      const perCal = p.caloriesFromThis / p.packages, perProt = (p.proteinFromThis || 0) / p.packages;
      return cal - perCal >= calTarget * 0.95 && prot - perProt >= proteinTarget * 0.95;
    }).sort((a, b) => (unitPrice(b.product) ?? 0) - (unitPrice(a.product) ?? 0));
    const p = opts[0];
    if (!p) return;
    const perCal = p.caloriesFromThis / p.packages, perProt = (p.proteinFromThis || 0) / p.packages;
    p.packages -= 1;
    p.caloriesFromThis = Math.round(perCal * p.packages);
    p.proteinFromThis = Math.round(perProt * p.packages);
    if (p.packages <= 0) v.plan.splice(v.plan.indexOf(p), 1);
  }
}

function finalize(v, entries, proteinTarget, calTarget) {
  annotate(v.plan);
  if (calTarget) { topUpCalories(v, entries, calTarget); trimExtras(v, proteinTarget, calTarget); }
  const t = totals(v.plan, proteinTarget, v.unmatched);
  const cal = t.plan.reduce((s, p) => s + (p.caloriesFromThis || 0), 0);
  return { ...t, totalCaloriesEstimate: Math.round(cal), calorieShortfall: calTarget ? Math.round(Math.max(0, calTarget - cal)) : 0 };
}

const signature = (p) => p.plan.map((x) => `${x.product?.upc}:${x.packages}`).sort().join("|");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }
  const goal = ["protein", "calories", "both"].includes(b.goal) ? b.goal : "protein";
  const calPerDay = Math.round(Number(b.targetCaloriesPerDay));
  const calTarget = goal === "protein" ? 0 : calPerDay * 7;
  if (goal !== "protein" && !(calPerDay >= 1200 && calPerDay <= 6000)) return res(400, { error: "Enter a daily calorie goal between 1200 and 6000" });
  const target = goal === "calories" ? Math.round(calTarget / 16) : Number(b.targetProteinPerWeek); // 25 percent of calories from protein, 4 calories per gram
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

    const ranked = finalize(buildRanked(entries, target), entries, target, calTarget);
    const cheapest = finalize(buildCheapest(entries, target), entries, target, calTarget);

    // Only call the cheapest plan "cheaper" when it also covers about the same amount of protein.
    const comparable = goal === "calories"
      ? cheapest.totalCaloriesEstimate >= ranked.totalCaloriesEstimate * 0.95
      : cheapest.totalProteinEstimate >= ranked.totalProteinEstimate * 0.95;
    const comparison = {
      same: signature(ranked) === signature(cheapest),
      comparable,
      savings: comparable ? round2(ranked.totalCost - cheapest.totalCost) : 0,
    };

    return res(200, { locationId, goal, targetProteinPerWeek: target, targetCaloriesPerDay: goal === "protein" ? 0 : calPerDay, ranked, cheapest, comparison });
  } catch (e) {
    return res(500, { error: e.message || "Could not build your protein plan" });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
