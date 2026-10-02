// POST { idToken, action, foods, goal, mealsPerDay, cookTime, ... } -> meal ideas built from the foods in the user's protein plan.
// Actions:
//   "day"    { dayIndex }                -> { meals: [...], dayProtein, dailyTarget }  (meals may include snacks, type "snack")
//   "swap"   { dayIndex, meal, avoid }   -> { meals: [oneMeal] }
//   "detail" { meal }                    -> { ingredients: [{ name, qty }], steps: [...], servings, proteinPerServing }
//
// foods: [{ name, weeklyProtein, weeklyCalories }]  (the user's own food names and what the plan gives them)
// goal: "protein" (default), "calories", or "both". It decides which cap keeps a single meal from being stuffed.
//
// PRIVACY / DESIGN NOTES
// - Only food names, amounts, and the cooking settings are sent to the model. No Kroger product, price,
//   brand, or image data is ever included (Kroger ToS Section 5e).
// - The model chooses meals and amounts of food. The PROTEIN NUMBERS ARE CALCULATED HERE from the
//   per-100g values in _nutrition.js. The model is told never to state nutrition numbers.
// - Nothing generated here is stored. The user can save a meal through the existing lists function.
const { getAdmin } = require("./_firebaseAdmin");
const { lookupProtein } = require("./_nutrition");

const MODEL = process.env.MEAL_MODEL || process.env.CLAUDE_MODEL || "claude-sonnet-5";
const THEMES = [
  "Mexican inspired", "Mediterranean", "Asian rice bowls and stir fries", "classic American comfort food",
  "Italian", "Indian inspired", "sheet pan and grill dinners",
];
const COOK = {
  quick: "Every meal must take 15 minutes or less of active cooking.",
  normal: "Every meal should take about 30 minutes or less.",
  cook: "Meals can take up to an hour when that makes them better.",
};
const G_PER_OZ = 28.3495;
// No single meal should carry more than about 50g of protein, and a snack about 30g. If the plan needs more
// than the chosen number of meals can hold, up to 2 snack slots are added so the protein is spread out.
const MEAL_CAP = 50, SNACK_CAP = 30, MAX_SNACKS = 2, CAP_TOLERANCE = 10;
const CAL_MEAL_CAP = 900, CAL_SNACK_CAP = 400, CAL_TOLERANCE = 100;
const BILLING = /credit balance|billing|purchase credits|plans & billing/i;
const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const per = (f, key) => (f.isCount ? f.nutrition[key + "PerUnit"] : f.nutrition[key + "Per100g"]) ?? 0;
const amountOf = (f, amount, key) => (f.isCount ? amount * per(f, key) : (amount / 100) * per(f, key));
const proteinOf = (f, amount) => amountOf(f, amount, "protein");
const caloriesOf = (f, amount) => amountOf(f, amount, "calories");

function cleanFoods(input) {
  const out = [], seen = new Set();
  for (const f of Array.isArray(input) ? input.slice(0, 8) : []) {
    const name = clean(f?.name, 60);
    const nutrition = lookupProtein(name);
    if (!name || !nutrition || nutrition.cartOnly || seen.has(name.toLowerCase())) continue; // cart only produce never drives meal weighting
    const isCount = nutrition.unit === "count";
    const probe = { isCount, nutrition };
    const wp = Number(f?.weeklyProtein), wc = Number(f?.weeklyCalories);
    let weeklyAmount = 0;
    if (wp > 0 && wp <= 50000 && per(probe, "protein") > 0) weeklyAmount = isCount ? wp / per(probe, "protein") : (wp / per(probe, "protein")) * 100;
    else if (wc > 0 && wc <= 500000 && per(probe, "calories") > 0) weeklyAmount = isCount ? wc / per(probe, "calories") : (wc / per(probe, "calories")) * 100;
    if (!(weeklyAmount > 0)) continue;
    seen.add(name.toLowerCase());
    out.push({ name, isCount, nutrition, weeklyAmount });
  }
  return out;
}

// Turns one model-written meal into a safe, validated meal with protein and calories computed from our own table.
// Meals over the cap for the chosen goal are scaled down so no single meal or snack is stuffed.
function sanitizeMeal(m, foods, goal = "protein") {
  const byName = new Map(foods.map((f) => [f.name.toLowerCase(), f]));
  const merged = new Map();
  for (const it of Array.isArray(m?.items) ? m.items : []) {
    const f = byName.get(String(it?.food ?? "").toLowerCase().trim());
    const amount = Number(it?.amount);
    if (!f || !(amount > 0)) continue;
    merged.set(f.name, (merged.get(f.name) || 0) + amount);
  }
  const type = m?.type === "snack" ? "snack" : "meal";
  const capP = type === "snack" ? SNACK_CAP : MEAL_CAP, capC = type === "snack" ? CAL_SNACK_CAP : CAL_MEAL_CAP;
  let rawP = 0, rawC = 0;
  for (const [name, amount] of merged) { const f = byName.get(name.toLowerCase()); rawP += proteinOf(f, amount); rawC += caloriesOf(f, amount); }
  const scaleP = goal !== "calories" && rawP > capP + CAP_TOLERANCE ? capP / rawP : 1;
  const scaleC = goal !== "protein" && rawC > capC + CAL_TOLERANCE ? capC / rawC : 1;
  const scale = Math.min(scaleP, scaleC);
  const items = [];
  for (const [name, rawAmount] of merged) {
    const f = byName.get(name.toLowerCase());
    const scaled = rawAmount * scale;
    const amount = f.isCount ? Math.min(30, Math.round(scaled * 2) / 2) : Math.min(2000, Math.round(scaled / 5) * 5);
    if (amount <= 0) continue;
    const qty = f.isCount ? String(amount) : `${amount} g (${(amount / G_PER_OZ).toFixed(1)} oz)`;
    items.push({ food: name, amount, qty, label: f.isCount ? `${amount} ${name}` : `${qty} ${name}`, protein: Math.round(proteinOf(f, amount)), calories: Math.round(caloriesOf(f, amount)) });
  }
  if (!items.length) return null;
  const title = clean(m?.title, 80);
  if (!title) return null;
  const minutes = Math.max(5, Math.min(180, Math.round(Number(m?.minutes)) || 30));
  const extras = (Array.isArray(m?.extras) ? m.extras : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 6);
  return {
    title,
    type,
    summary: clean(m?.summary, 220),
    minutes,
    items,
    extras,
    protein: items.reduce((s, i) => s + i.protein, 0),
    calories: items.reduce((s, i) => s + i.calories, 0),
  };
}

// How many meals and snacks a day needs so each stays under its cap for the chosen goal.
function slotPlan(foods, perDay, goal = "protein") {
  const daily = foods.reduce((t, f) => t + proteinOf(f, f.weeklyAmount / 7), 0);
  const dailyCal = foods.reduce((t, f) => t + caloriesOf(f, f.weeklyAmount / 7), 0);
  let snacks = 0;
  while (snacks < MAX_SNACKS && (
    (goal !== "calories" && perDay * MEAL_CAP + snacks * SNACK_CAP < daily) ||
    (goal !== "protein" && perDay * CAL_MEAL_CAP + snacks * CAL_SNACK_CAP < dailyCal)
  )) snacks++;
  return { meals: perDay, snacks, daily: Math.round(daily), dailyCal: Math.round(dailyCal) };
}

async function askModel(system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error(data.error?.message || "Model error");
    err.status = r.status;
    throw err;
  }
  const out = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
}

const MEAL_SYSTEM = `You plan varied, realistic home cooked meals for one person. The person already bought specific protein foods, and your job is to spread them across meals so they never get bored. Rules:
- Use ONLY the listed foods as main ingredients. They are protein foods and may also include staples like rice, pasta, oats, bread, potatoes, oil, or peanut butter. Never add other meat, fish, eggs, tofu, beans, lentils, protein powder, or dairy protein as a main ingredient.
- Use roughly the listed amount of each food across the meals you write. Not every food has to be in every meal.
- "extras" are simple, cheap, low protein staples (rice, pasta, bread, tortillas, potatoes, oats, fruit, vegetables, oil, sauces, spices). Keep each extra a short plain grocery term like "frozen broccoli". No more than 5 per meal.
- "food" must be copied exactly from the list. "amount" is grams of that food as bought for weight foods, or a plain number for count foods like eggs.
- Never mention protein, calories, or any nutrition numbers. Never mention prices or brands.
- Meals must differ from each other in flavor and style.
- Split each food's daily amount across the meals and snacks so every meal gets a similar share. Never put most of a day's food into one meal.
- A snack is a small, quick item (5 minutes or less) that gets a smaller share than a meal. List the meals first, then the snacks.
Respond with ONLY JSON, no markdown: {"meals":[{"title":str,"type":"meal" or "snack","summary":str,"minutes":number,"items":[{"food":str,"amount":number}],"extras":[str]}]}
"summary" is one short sentence describing how the meal is made.`;

const DETAIL_SYSTEM = `Write a short, practical recipe for the meal described. Respond with ONLY JSON, no markdown: {"ingredients":[{"name":str,"qty":str}],"steps":[str]}
- "ingredients": every item in the meal. Use the exact amounts given for the protein foods and rough amounts for the extras. "name" is a plain grocery term.
- "steps": 3 to 5 steps, one or two sentences each.
- When cooking raw meat, poultry, pork, or fish, include the safe internal temperature.
- Never mention calories, protein, or any nutrition numbers. Never mention prices or brands.`;

function foodLines(foods) {
  return foods.map((f) => {
    const daily = f.weeklyAmount / 7;
    return f.isCount ? `- ${f.name}: about ${Math.max(1, Math.round(daily))} per day (count)` : `- ${f.name}: about ${Math.max(5, Math.round(daily / 5) * 5)} g per day`;
  }).join("\n");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return res(500, { error: "Missing ANTHROPIC_API_KEY" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }
  if (!b.idToken) return res(401, { error: "Sign in to get meal ideas." });

  try {
    try { await getAdmin().auth().verifyIdToken(b.idToken); }
    catch { return res(401, { error: "Please sign in again." }); }

    const foods = cleanFoods(b.foods);
    if (!foods.length) return res(400, { error: "Your plan has no foods with nutrition estimates to build meals from." });
    const perDay = [2, 3, 4].includes(Number(b.mealsPerDay)) ? Number(b.mealsPerDay) : 3;
    const cook = COOK[b.cookTime] ? b.cookTime : "normal";
    const goal = ["protein", "calories", "both"].includes(b.goal) ? b.goal : "protein";

    if (b.action === "day") {
      const i = Math.max(0, Math.min(6, Math.round(Number(b.dayIndex)) || 0));
      const plan = slotPlan(foods, perDay, goal);
      const slots = `${plan.meals} meals${plan.snacks ? ` and ${plan.snacks} snack${plan.snacks > 1 ? "s" : ""}` : ""}`;
      const user = `Plan ${slots} for day ${i + 1} of 7.
Style for the day: ${THEMES[i % THEMES.length]}.
${COOK[cook]}
Protein foods to spread across the day's meals:
${foodLines(foods)}`;
      const out = await askModel(MEAL_SYSTEM, user, 1400);
      const meals = (Array.isArray(out.meals) ? out.meals : []).map((m) => sanitizeMeal(m, foods, goal)).filter(Boolean).slice(0, plan.meals + plan.snacks);
      if (!meals.length) return res(502, { error: "Could not plan this day. Try again." });
      return res(200, { meals, dayProtein: meals.reduce((s, m) => s + m.protein, 0), dailyTarget: plan.daily, dayCalories: meals.reduce((s, m) => s + m.calories, 0), dailyCalorieTarget: plan.dailyCal });
    }

    if (b.action === "swap") {
      const old = sanitizeMeal(b.meal, foods, goal);
      if (!old) return res(400, { error: "Missing meal to swap" });
      const avoid = (Array.isArray(b.avoid) ? b.avoid : []).map((t) => clean(t, 80)).filter(Boolean).slice(0, 30);
      const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
      const user = `Write exactly 1 replacement ${old.type === "snack" ? "snack (small and quick, 5 minutes or less)" : "meal"}. Style: ${theme}.
${COOK[cook]}
Use these protein foods in these exact amounts:
${old.items.map((it) => `- ${it.food}: ${it.amount}${foods.find((f) => f.name === it.food)?.isCount ? " (count)" : " g"}`).join("\n")}
Do not reuse any of these meal titles: ${avoid.join("; ") || "none"}`;
      const out = await askModel(MEAL_SYSTEM, user, 500);
      const meal = sanitizeMeal({ ...(Array.isArray(out.meals) ? out.meals : [])[0], type: old.type }, foods, goal);
      if (!meal) return res(502, { error: "Could not find a swap. Try again." });
      return res(200, { meals: [meal] });
    }

    if (b.action === "detail") {
      const m = sanitizeMeal(b.meal, foods, goal);
      if (!m) return res(400, { error: "Missing meal" });
      const user = `Meal: ${m.title}. ${m.summary}
Protein foods and exact amounts:
${m.items.map((it) => `- ${it.food}: ${it.qty}`).join("\n")}
Extras: ${m.extras.join(", ") || "none"}`;
      const out = await askModel(DETAIL_SYSTEM, user, 700);
      const ingredients = (Array.isArray(out.ingredients) ? out.ingredients : [])
        .map((i) => ({ name: clean(i?.name, 100), qty: clean(i?.qty, 50) })).filter((i) => i.name).slice(0, 15);
      const steps = (Array.isArray(out.steps) ? out.steps : []).map((s) => clean(s, 300)).filter(Boolean).slice(0, 6);
      if (!steps.length) return res(502, { error: "Could not write that recipe. Try again." });
      // Every planned meal is written for one person, so servings is 1. The protein figure is the one we
      // calculated from our own table (plan foods only), never a number from the model.
      return res(200, { ingredients, steps, servings: 1, proteinPerServing: m.protein, caloriesPerServing: m.calories });
    }

    return res(400, { error: "Unknown action" });
  } catch (e) {
    // The real reason goes to the Netlify function logs; the user gets a short, honest message.
    console.error("meal-ideas failed:", e.status || "", e.message);
    const outOfCredit = e.status === 402 || (e.status === 400 && BILLING.test(e.message || ""));
    if (outOfCredit || e.status === 401 || e.status === 403) return res(503, { error: "Meal ideas are temporarily unavailable." });
    if (e.status === 429 || e.status === 529) return res(503, { error: "Meal ideas are busy right now. Try again in a minute." });
    return res(500, { error: "Could not build meal ideas. Try again." });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
