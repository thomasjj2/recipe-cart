// POST { goal: "protein"|"calories"|"both", targetProteinPerWeek, targetCaloriesPerDay, preferences: [string,...] ranked highest first, zip, locationId?, spreadFoods? }
// Calories goal derives a protein floor (25 percent of calories from protein). Both goals run protein first, then fill calories.
// -> { locationId, targetProteinPerWeek, ranked: PLAN, cheapest: PLAN, comparison }
//    where PLAN = { plan: [...], unmatched: [...], totalProteinEstimate, totalCost, shortfall }
//
// Builds TWO combined plans from ONE set of live Kroger searches (nothing is stored):
//  ranked   walks down the user's preferences in order, using the first search result for each,
//           and buys enough to cover a share of what is still needed.
//  cheapest looks at every search result for every preference, picks the product with the lowest
//           price per gram of protein for each food, then fills the goal from the cheapest food up,
//           still limited to the foods the user listed.
//
// CALORIE GOALS (calories or both)
//  - Cap: a plan never goes over 105 percent of the weekly calorie goal, and counts as met at 95 percent or more.
//  - Package fit: a product is only used if ONE package fits inside what the food is allowed to cover, so a
//    20 lb bag of rice or a 48 oz bottle of oil can't blow past the goal. Smaller sizes of the same food are used instead.
//  - spreadFoods (default true for calorie goals): the ranked plan spreads the calories down the WHOLE list,
//    with the top foods getting bigger shares, instead of stopping once protein is covered by the first couple of foods.
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
function buildRanked(entries, target, denseOnly = false) {
  const plan = [], skipped = [];
  let remaining = target;
  for (const e of entries) {
    if (remaining <= 0) break; // goal already met by earlier picks (calorie goals keep going down the list in fillCalories)
    if (e.nutrition && e.nutrition.proteinPer100g === 0) continue; // calorie only foods are added in the calorie fill
    if (denseOnly && e.nutrition && !isProteinDense(e.nutrition)) continue; // carb staples are added in the calorie fill
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
function buildCheapest(entries, target, denseOnly = false) {
  const candidates = [], skipped = [];
  for (const e of entries) {
    if (!e.matches.length) { skipped.push({ rank: e.rank, name: e.name, reason: "not_carried" }); continue; }
    if (!e.nutrition) { skipped.push({ rank: e.rank, name: e.name, reason: "no_estimate" }); continue; }
    if (e.nutrition.proteinPer100g === 0) continue; // calorie only foods are added in the calorie fill
    if (denseOnly && !isProteinDense(e.nutrition)) continue; // carb staples are added in the calorie fill
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

// ---- Calorie goals ----
const CAL_CAP = 1.05;          // a plan never goes over 105% of the weekly calorie goal
const CAL_FLOOR = 0.95;        // and counts as met at 95% or more
const CAL_SHARE = 0.4;         // no single food covers more than 40% of the calorie goal
const CAL_SHARE_DENSE = 0.2;   // oils and nut butters (500+ cal per 100g) cover at most 20%, nobody eats a week of oil
const CAL_SHARE_LIGHT = 0.25;  // low calorie foods (under 150 cal per 100g, and eggs) cover at most 25%, so no 17 cans of beans
const calShareFor = (n) => {
  if (!n) return CAL_SHARE;
  if (n.unit === "count") return CAL_SHARE_LIGHT;
  const d = n.caloriesPer100g ?? 0;
  return d >= 500 ? CAL_SHARE_DENSE : d < 150 ? CAL_SHARE_LIGHT : CAL_SHARE;
};
// On a calorie goal the protein step only uses real protein foods (20%+ of their calories from protein).
// Carb staples like rice, pasta and oats are left to the calorie fill, so they can't "cover" the protein floor.
const PROTEIN_DENSE = 0.2;
const isProteinDense = (n) => {
  const p = n.unit === "count" ? n.proteinPerUnit : n.proteinPer100g;
  const c = n.unit === "count" ? n.caloriesPerUnit : n.caloriesPer100g;
  return !!c && (p * 4) / c >= PROTEIN_DENSE;
};
const planCalories = (plan) => plan.reduce((s, p) => s + (p.caloriesFromThis || 0), 0);

function annotate(plan) {
  for (const p of plan) {
    if (!p.packages) continue;
    const cp = amountPerPackage(lookupProtein(p.name), { size: p.product?.size }, "calories");
    p.caloriesFromThis = cp ? Math.round(p.packages * cp) : null;
  }
}

// Picks a product whose single package fits inside `room` calories, so a 20 lb bag of rice or a 48 oz bottle of oil
// is skipped when it would blow past the goal. cheap = lowest price per calorie, otherwise the first (most relevant) fit.
function pickProduct(e, room, cheap) {
  const askedPrepared = PREPARED.test(e.name);
  let best = null;
  for (const top of e.matches) {
    if (!askedPrepared && PREPARED.test(top.description || "")) continue;
    const item = top.items?.[0];
    const perCal = amountPerPackage(e.nutrition, item, "calories");
    const product = toProduct(top, item);
    const price = unitPrice(product);
    if (!perCal || price == null || price <= 0 || perCal > room) continue;
    const cpc = price / perCal;
    if (!best || (cheap && cpc < best.cpc)) best = { product, perCal, cpc };
    if (!cheap) break;
  }
  return best;
}

// Lowest price per calorie across every result for a food, used only to order foods in cheapest mode.
function minCostPerCalorie(e) {
  let m = Infinity;
  for (const top of e.matches) {
    const item = top.items?.[0];
    const perCal = amountPerPackage(e.nutrition, item, "calories");
    const price = unitPrice(toProduct(top, item));
    if (perCal && price > 0) m = Math.min(m, price / perCal);
  }
  return m;
}

// Adds calories until the weekly goal is covered, never past the cap.
//  cheap  = go through foods from the lowest price per calorie up. Otherwise go down the user's ranking.
//  spread = (ranked only) first give EVERY listed food a rank weighted share of the goal, so the whole list is used.
function fillCalories(v, entries, calTarget, cheap, spread) {
  const cap = calTarget * CAL_CAP, floor = calTarget * CAL_FLOOR;
  const cands = entries.filter((e) => e.nutrition && e.matches.length);
  if (cheap) cands.sort((a, b) => minCostPerCalorie(a) - minCostPerCalorie(b));

  const fill = (e, want) => {
    let line = v.plan.find((p) => p.packages && p.name === e.name);
    const already = line?.caloriesFromThis || 0;
    const room = Math.min(cap - planCalories(v.plan), calShareFor(e.nutrition) * calTarget - already);
    if (room <= 0) return;
    let product, perCal;
    if (line) {
      product = line.product;
      perCal = amountPerPackage(e.nutrition, { size: product?.size }, "calories");
    } else {
      const pick = pickProduct(e, room, cheap);
      if (pick) ({ product, perCal } = pick);
    }
    if (!product || !perCal) return;
    // Round to the nearest package, but never past what the cap and this food's share allow.
    const add = Math.min(Math.round(Math.min(want, room) / perCal), Math.floor(room / perCal));
    if (add < 1) return;
    if (line) line.packages += add;
    else {
      line = { rank: e.rank, name: e.name, product, packages: add, confidence: e.nutrition.confidence || null,
        assumptionNote: e.nutrition.note || null, wasFallback: false, addedForCalories: true };
      v.plan.push(line);
    }
    const pp = amountPerPackage(e.nutrition, { size: product.size }, "protein");
    if (pp != null) line.proteinFromThis = Math.round(line.packages * pp);
    line.caloriesFromThis = Math.round(line.packages * perCal);
    line.costPer100gProtein = pp ? costPer100g(line.product, pp) : null;
  };

  if (spread && !cheap) {
    const weights = cands.map((_, i) => cands.length - i); // top food gets the biggest share
    const sum = weights.reduce((a, b) => a + b, 0);
    cands.forEach((e, i) => {
      const already = v.plan.find((p) => p.packages && p.name === e.name)?.caloriesFromThis || 0;
      fill(e, (calTarget * weights[i]) / sum - already);
    });
  }
  // Top up anything still short, in the same order.
  for (const e of cands) {
    if (planCalories(v.plan) >= floor) break;
    fill(e, calTarget - planCalories(v.plan));
  }
}

function dropPackage(v, p) {
  const perCal = p.caloriesFromThis / p.packages, perProt = (p.proteinFromThis || 0) / p.packages;
  p.packages -= 1;
  p.caloriesFromThis = Math.round(perCal * p.packages);
  p.proteinFromThis = Math.round(perProt * p.packages);
  if (p.packages <= 0) v.plan.splice(v.plan.indexOf(p), 1);
}

// Staples picked for protein (like rice) can overshoot calories. Drop the priciest package while both goals stay within 5 percent.
function trimExtras(v, proteinTarget, calTarget) {
  for (;;) {
    const prot = v.plan.reduce((s, p) => s + (p.proteinFromThis || 0), 0);
    const cal = planCalories(v.plan);
    const opts = v.plan.filter((p) => {
      if (!p.packages || !p.caloriesFromThis) return false;
      const perCal = p.caloriesFromThis / p.packages, perProt = (p.proteinFromThis || 0) / p.packages;
      return cal - perCal >= calTarget * CAL_FLOOR && prot - perProt >= proteinTarget * 0.95;
    }).sort((a, b) => (unitPrice(b.product) ?? 0) - (unitPrice(a.product) ?? 0));
    const p = opts[0];
    if (!p) return;
    dropPackage(v, p);
  }
}

// Hard cap. If the plan is still over 105% of the calorie goal, drop packages until it is under,
// giving up the least protein per calorie first. Never drops below the 95% floor if another choice exists.
function enforceCap(v, calTarget) {
  const cap = calTarget * CAL_CAP, floor = calTarget * CAL_FLOOR;
  for (;;) {
    const cal = planCalories(v.plan);
    if (cal <= cap) return;
    const opts = v.plan.filter((p) => p.packages && p.caloriesFromThis);
    const perCalOf = (p) => p.caloriesFromThis / p.packages;
    const density = (p) => (p.proteinFromThis || 0) / p.caloriesFromThis;
    let pool = opts.filter((p) => cal - perCalOf(p) >= floor).sort((a, b) => density(a) - density(b));
    if (!pool.length) {
      // Every package is big enough to undershoot. Only drop one if that lands closer to the goal than we are now.
      pool = opts
        .filter((p) => Math.abs(cal - perCalOf(p) - calTarget) < Math.abs(cal - calTarget))
        .sort((a, b) => Math.abs(cal - perCalOf(a) - calTarget) - Math.abs(cal - perCalOf(b) - calTarget));
    }
    if (!pool.length) return;
    dropPackage(v, pool[0]);
  }
}

function finalize(v, entries, proteinTarget, calTarget, cheap = false, spread = false) {
  annotate(v.plan);
  if (calTarget) {
    enforceCap(v, calTarget);                          // protein picks alone shouldn't already be over the cap
    fillCalories(v, entries, calTarget, cheap, spread);
    trimExtras(v, proteinTarget, calTarget);
    enforceCap(v, calTarget);                          // safety net
    if (!cheap) v.plan.sort((a, b) => a.rank - b.rank); // ranked plan reads in the user's order
  }
  const t = totals(v.plan, proteinTarget, v.unmatched);
  const cal = planCalories(t.plan);
  return {
    ...t,
    totalCaloriesEstimate: Math.round(cal),
    calorieShortfall: calTarget && cal < calTarget * CAL_FLOOR ? Math.round(calTarget - cal) : 0,
  };
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
  // Calorie goals use the whole ranked list by default. Send spreadFoods: false to go back to "stop once covered".
  const spread = goal !== "protein" && b.spreadFoods !== false;

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

    const ranked = finalize(buildRanked(entries, target, goal !== "protein"), entries, target, calTarget, false, spread);
    const cheapest = finalize(buildCheapest(entries, target, goal !== "protein"), entries, target, calTarget, true, false);

    // Only call the cheapest plan "cheaper" when it also covers about the same amount of protein.
    const comparable = goal === "calories"
      ? cheapest.totalCaloriesEstimate >= ranked.totalCaloriesEstimate * 0.95
      : cheapest.totalProteinEstimate >= ranked.totalProteinEstimate * 0.95;
    const comparison = {
      same: signature(ranked) === signature(cheapest),
      comparable,
      savings: comparable ? round2(ranked.totalCost - cheapest.totalCost) : 0,
    };

    return res(200, { locationId, goal, spreadFoods: spread, targetProteinPerWeek: target, targetCaloriesPerDay: goal === "protein" ? 0 : calPerDay, ranked, cheapest, comparison });
  } catch (e) {
    return res(500, { error: e.message || "Could not build your protein plan" });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
