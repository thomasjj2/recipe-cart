// POST { goal: "protein"|"calories"|"both", targetProteinPerWeek, targetCaloriesPerDay, preferences: [string,...] the foods the user picked (order only breaks ties), zip, locationId? }
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
//  - Balanced plan (the plan the app calls "Balanced"; the response key is still `ranked`): splits the protein goal evenly
//    across the picked protein foods, and spreads calories evenly across the WHOLE list, so every pick is used. There is no
//    ranking. The order of the picks only breaks ties. Sending spreadFoods: false on a calorie goal restores the old
//    "walk the list in order and stop once covered" behavior.
//  - Protein cap (option B): once the protein goal is met, protein dense foods (meat, fish, eggs, dairy) are not added
//    again. The rest of the calories come from carbs and fats, which can carry their own small amount of protein.
//    If the picks have too few carbs and fats, the plan stops short and says so, instead of overshooting protein.
// WRONG FOOD GUARD: a Kroger search for a card food can return a different food (a "93/7" search can return ground turkey).
//  For card foods, products are kept only if the name passes the card's mustHave and mustNot words (see _nutrition.js).
// BALANCED PICKS EVEN SIZES: the Balanced plan splits the goal evenly across the picked foods. For each food it keeps the package
//  sizes that land closest to that food's even share (a 1 lb tray rather than a 3 lb tray when the share is 350g), then takes the
//  cheapest of those by price per gram of protein. Evenness comes first, price second. The calorie fill and cart only produce
//  always take the cheapest suitable product.
// OVERSIZED PACKAGES: a product is skipped when ONE package alone is more than the goal allows, because it could never
//  land near the goal: more than 65% of the protein goal, or more than the food's own calorie share of the calorie goal
//  (a 20 lb box of protein bars, a 10 lb bag of rice). Smaller sizes of the same food are used instead. If every size
//  at the store is too big, the food is left out and the plan says so ("package_too_big").
// CART ONLY FOODS (tomatoes, spinach and other low calorie produce): skipped by every protein and calorie step,
//  then added at the end as one package each, so they are in the cart but never counted toward a goal.
const { searchProducts, findNearestLocation } = require("./_kroger");
const { lookupProtein, matchesFood, PLANNING, calShareFor, isProteinDense } = require("./_nutrition");

const LBS_PER_KG = 2.20462;
const MAX_SHARE_PER_ITEM = PLANNING.MAX_SHARE_PER_ITEM; // no single food covers more than 65% of the goal, unless it's the last option left

function parseSizeToLbs(size) {
  if (!size) return null;
  const s = String(size).toLowerCase();
  let lbs = 0, found = false;
  const flMatch = s.match(/([\d.]+)\s*fl\s*oz/);
  if (flMatch) { lbs += (parseFloat(flMatch[1]) * 0.95) / 16; found = true; }
  const lbMatch = s.match(/([\d.]+)\s*lb/);
  const ozMatch = s.match(/([\d.]+)\s*oz/);
  const kgMatch = s.match(/([\d.]+)\s*kg/);
  // Volume sizes (milk, oil), converted to weight in pounds.
  const fracGal = s.match(/(\d+)\s*\/\s*(\d+)\s*gal/);
  const gal = s.match(/([\d.]+)\s*gal/);
  const qt = s.match(/([\d.]+)\s*(?:qt|quart)/);
  const pt = s.match(/([\d.]+)\s*(?:pt|pint)\b/);
  const ml = s.match(/([\d.]+)\s*ml\b/);
  const liter = s.match(/([\d.]+)\s*(?:l|liter|litre)\b/);
  if (fracGal) { lbs += (parseInt(fracGal[1], 10) / parseInt(fracGal[2], 10)) * 8.6; found = true; }
  else if (gal) { lbs += parseFloat(gal[1]) * 8.6; found = true; }
  else if (/half\s*gal/.test(s)) { lbs += 4.3; found = true; }
  if (qt) { lbs += parseFloat(qt[1]) * 2.15; found = true; }
  if (pt) { lbs += parseFloat(pt[1]) * 1.07; found = true; }
  if (ml) { lbs += parseFloat(ml[1]) * 0.0022; found = true; }
  if (liter) { lbs += parseFloat(liter[1]) * 2.2; found = true; }
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

// True when a single package is small enough for the goals. Unknown sizes pass here, the builders skip them later.
function fitsGoal(nutrition, item, proteinTarget, calTarget) {
  const pp = amountPerPackage(nutrition, item, "protein");
  if (pp && pp > proteinTarget * MAX_SHARE_PER_ITEM) return false;
  if (calTarget) {
    const cp = amountPerPackage(nutrition, item, "calories");
    if (cp && cp > calShareFor(nutrition) * calTarget) return false;
  }
  return true;
}
const missReason = (e) => (e.tooBig ? "package_too_big" : "not_carried");

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

// Balanced: the protein goal is split evenly across the usable protein foods. Each gets the package count closest to its
// share, then packages are added or removed so the total lands within about 5 percent of the goal.
function buildBalanced(entries, target, denseOnly) {
  const lines = [], skipped = [], usable = [], elig = [];
  for (const e of entries) {
    if (e.nutrition?.cartOnly) continue; // cart only produce is added at the end
    if (e.nutrition && e.nutrition.proteinPer100g === 0) continue; // calorie only foods are added in the calorie fill
    if (denseOnly && e.nutrition && !isProteinDense(e.nutrition)) continue; // carb staples are added in the calorie fill
    if (!e.matches[0]) { skipped.push({ rank: e.rank, name: e.name, reason: missReason(e) }); continue; }
    const cands = e.matches.map((t) => { const item = t.items?.[0]; return { pp: proteinPerPackage(e.nutrition, item), product: toProduct(t, item), desc: t.description || "" }; });
    elig.push({ e, cands });
  }
  const share = elig.filter((x) => x.cands.some((c) => c.pp)).length ? target / elig.filter((x) => x.cands.some((c) => c.pp)).length : 0;
  for (const { e, cands } of elig) {
    const ok = cands.filter((c) => c.pp);
    // Evenness first: how far each size lands from this food's even share (rounded to whole packages), in percent of the share.
    // Keep the sizes within 10 points of the most even one, then take the cheapest of those by price per gram of protein.
    const miss = (c) => Math.abs(Math.max(1, Math.round(share / c.pp)) * c.pp - share) / (share || 1);
    const best = ok.length ? Math.min(...ok.map(miss)) : 0;
    const pool = ok.filter((c) => miss(c) <= best + 0.1);
    // Skip prepared items unless asked for.
    const plain = pool.filter((c) => PREPARED.test(e.name) || !PREPARED.test(c.desc));
    const fit = (plain.length ? plain : pool).reduce((pick, c) => {
      const price = unitPrice(c.product), cpg = price > 0 ? price / c.pp : Infinity;
      return !pick || cpg < pick.cpg ? { ...c, cpg } : pick;
    }, null);
    const line = { e, rank: e.rank, name: e.name, product: (fit || cands[0]).product, perPackage: fit ? fit.pp : null, packages: fit ? 0 : null };
    lines.push(line);
    if (fit) usable.push(line);
  }
  for (const l of usable) l.packages = Math.max(1, Math.round(share / l.perPackage));
  const have = () => usable.reduce((s, l) => s + l.packages * l.perPackage, 0);
  const deficit = (l) => share - l.packages * l.perPackage;
  for (let g = 0; g < 60 && usable.length && have() < target * 0.97; g++) {
    usable.sort((a, b) => deficit(b) - deficit(a));
    usable[0].packages += 1;
  }
  for (let g = 0; g < 60 && usable.length && have() > target * 1.05; g++) {
    const over = usable.filter((l) => l.packages > 1 && have() - l.perPackage >= target * 0.95).sort((a, b) => deficit(a) - deficit(b));
    if (!over.length) break;
    over[0].packages -= 1;
  }
  const plan = lines.map((l) => l.perPackage
    ? {
        rank: l.rank, name: l.name, product: l.product, packages: l.packages,
        proteinFromThis: Math.round(l.packages * l.perPackage),
        costPer100gProtein: costPer100g(l.product, l.perPackage),
        confidence: l.e.nutrition?.confidence || null,
        assumptionNote: l.e.nutrition?.note || null,
        wasFallback: false,
      }
    : { rank: l.rank, name: l.name, product: l.product, packages: null, proteinFromThis: null,
        note: "Couldn't determine a reliable quantity for this item.", wasFallback: false });
  return totals(plan, target, skipped);
}

// Walks the list in order (the old ranked behavior). Used only when spreadFoods is false on a calorie goal.
function buildRanked(entries, target, denseOnly = false, even = false) {
  if (even) return buildBalanced(entries, target, denseOnly);
  const plan = [], skipped = [];
  let remaining = target;
  for (const e of entries) {
    if (e.nutrition?.cartOnly) continue; // cart only produce is added at the end
    if (remaining <= 0) break; // goal already met by earlier picks (calorie goals keep going down the list in fillCalories)
    if (e.nutrition && e.nutrition.proteinPer100g === 0) continue; // calorie only foods are added in the calorie fill
    if (denseOnly && e.nutrition && !isProteinDense(e.nutrition)) continue; // carb staples are added in the calorie fill
    const top = e.matches[0] || null;
    if (!top) { skipped.push({ rank: e.rank, name: e.name, reason: missReason(e) }); continue; }

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
    if (e.nutrition?.cartOnly) continue; // cart only produce is added at the end
    if (!e.matches.length) { skipped.push({ rank: e.rank, name: e.name, reason: missReason(e) }); continue; }
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
// Option B setting. 1 = once the protein goal is met, protein dense foods stop being added (strict). Raise it, for example
// to 1.3, to let them top up calories up to 130% of the protein goal when the picks have too few carbs and fats.
const PROTEIN_CEILING = 1;
// Protein balance. Packages are big (a 3 lb turkey tray is about 260g of protein) and carbs carry some protein too,
// so a Both or Calories plan can land well over the protein goal. Above this multiple of the goal, the planner tries
// swapping protein packages for carbs and fats, as long as calories stay inside the 95 to 105% window.
const PROTEIN_MAX = 1.1;
// While swapping, carbs and fats may exceed their usual per food calorie share by this factor (25 percent), because the
// usual 40% share often leaves no room for the calories that the dropped protein package was providing.
const REBALANCE_SHARE_BOOST = 1.25;
// Per food calorie shares (calShareFor) and the protein dense test (isProteinDense) live in _nutrition.js,
// so the app's feasibility meter uses exactly the same rules.
const planCalories = (plan) => plan.reduce((s, p) => s + (p.caloriesFromThis || 0), 0);
const planProtein = (plan) => plan.reduce((s, p) => s + (p.proteinFromThis || 0), 0);

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
function fillCalories(v, entries, calTarget, cheap, spread, proteinTarget, shareBoost = 1) {
  const cap = calTarget * CAL_CAP, floor = calTarget * CAL_FLOOR;
  const cands = entries.filter((e) => e.nutrition && !e.nutrition.cartOnly && e.matches.length);
  if (cheap) cands.sort((a, b) => minCostPerCalorie(a) - minCostPerCalorie(b));

  const fill = (e, want) => {
    // Option B: protein dense foods are bought for protein only. Once that goal is met, calories come from carbs and fats.
    if (isProteinDense(e.nutrition) && planProtein(v.plan) >= proteinTarget * PROTEIN_CEILING) return;
    let line = v.plan.find((p) => p.packages && p.name === e.name);
    const already = line?.caloriesFromThis || 0;
    const room = Math.min(cap - planCalories(v.plan), calShareFor(e.nutrition) * shareBoost * calTarget - already);
    if (room <= 0) return;
    let product, perCal;
    if (line) {
      product = line.product;
      perCal = amountPerPackage(e.nutrition, { size: product?.size }, "calories");
    } else {
      const pick = pickProduct(e, room, true); // always the cheapest suitable product
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
    const weights = cands.map(() => 1); // every picked food gets an equal share
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

const planCost = (plan) => plan.reduce((s, p) => s + (unitPrice(p.product) ?? 0) * (p.packages || 0), 0);

// Tries dropping one package of a protein dense food, then refilling the lost calories from carbs and fats only.
// Keeps the best result that is closer to the protein goal with calories still inside the window. Repeats until the
// protein is within PROTEIN_MAX of the goal, or no swap helps (for example when the picks have no carbs or fats).
function rebalanceProtein(v, entries, proteinTarget, calTarget, cheap) {
  const cap = calTarget * CAL_CAP, floor = calTarget * CAL_FLOOR;
  for (let guard = 0; guard < 12; guard++) {
    const prot = planProtein(v.plan);
    if (prot <= proteinTarget * PROTEIN_MAX) return;
    let best = null;
    for (const line of v.plan) {
      if (!line.packages || line.cartOnly) continue;
      const n = lookupProtein(line.name);
      if (!n || !isProteinDense(n)) continue;
      const trial = { plan: JSON.parse(JSON.stringify(v.plan)), unmatched: v.unmatched };
      dropPackage(trial, trial.plan.find((p) => p.name === line.name && p.product?.upc === line.product?.upc));
      fillCalories(trial, entries, calTarget, cheap, false, 0, REBALANCE_SHARE_BOOST); // proteinTarget 0 means protein dense foods are never re-added
      const tp = planProtein(trial.plan), tc = planCalories(trial.plan);
      if (tc < floor || tc > cap || Math.abs(tp - proteinTarget) >= Math.abs(prot - proteinTarget)) continue;
      const score = Math.abs(tp - proteinTarget);
      if (!best || score < best.score || (score === best.score && planCost(trial.plan) < planCost(best.trial.plan))) best = { trial, score };
    }
    if (!best) return;
    v.plan = best.trial.plan;
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

// One package of each cart only food (low calorie produce). Not counted toward any goal.
function addCartOnly(v, entries, cheap) {
  for (const e of entries) {
    if (!e.nutrition?.cartOnly) continue;
    if (!e.matches.length) { v.unmatched.push({ rank: e.rank, name: e.name, reason: "not_carried" }); continue; }
    const askedPrepared = PREPARED.test(e.name);
    let pick = null;
    for (const top of e.matches) {
      if (!askedPrepared && PREPARED.test(top.description || "")) continue;
      const product = toProduct(top, top.items?.[0]);
      const price = unitPrice(product);
      if (!pick) pick = { product, price };
      if (price != null && price > 0 && (pick.price == null || price < pick.price)) pick = { product, price };
    }
    if (!pick) continue;
    v.plan.push({ rank: e.rank, name: e.name, product: pick.product, packages: 1, proteinFromThis: 0, caloriesFromThis: 0,
      cartOnly: true, confidence: null, assumptionNote: null, wasFallback: false });
  }
}

function finalize(v, entries, proteinTarget, calTarget, cheap = false, spread = false) {
  annotate(v.plan);
  if (calTarget) {
    enforceCap(v, calTarget);                          // protein picks alone shouldn't already be over the cap
    fillCalories(v, entries, calTarget, cheap, spread, proteinTarget);
    trimExtras(v, proteinTarget, calTarget);
    rebalanceProtein(v, entries, proteinTarget, calTarget, cheap);
    enforceCap(v, calTarget);                          // safety net
    if (!cheap) v.plan.sort((a, b) => a.rank - b.rank); // ranked plan reads in the user's order
  }
  addCartOnly(v, entries, cheap);
  const t = totals(v.plan, proteinTarget, v.unmatched);
  const cal = planCalories(t.plan);
  return {
    ...t,
    totalCaloriesEstimate: Math.round(cal),
    calorieShortfall: calTarget && cal < calTarget * CAL_FLOOR ? Math.round(calTarget - cal) : 0,
    proteinOver: calTarget && t.totalProteinEstimate > proteinTarget * PROTEIN_MAX ? Math.round(t.totalProteinEstimate - proteinTarget) : 0,
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
    // Drop oversized packages up front, so every plan (balanced, cheapest, calorie fill, rebalance) only sees sizes that fit.
    for (const e of entries) {
      if (!e.nutrition) continue;
      // Card foods only: drop results that are a different food (guard words come from _nutrition.js).
      const isCard = !!e.nutrition.searchTerm && e.name.toLowerCase() === e.nutrition.searchTerm.toLowerCase();
      const relevant = isCard ? e.matches.filter((top) => matchesFood(e.nutrition, top.description)) : e.matches;
      e.matches = relevant.filter((top) => fitsGoal(e.nutrition, top.items?.[0], target, calTarget));
      e.tooBig = relevant.length > 0 && e.matches.length === 0;
    }

    const ranked = finalize(buildRanked(entries, target, goal !== "protein", goal === "protein" || spread), entries, target, calTarget, false, spread);
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
