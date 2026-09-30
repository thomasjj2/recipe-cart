// POST { idToken, action, foods, mealsPerDay, cookTime, ... } -> meal ideas built from the foods in the user's protein plan.
// Actions:
//   "day"    { dayIndex }                -> { meals: [...], dayProtein }
//   "swap"   { dayIndex, meal, avoid }   -> { meals: [oneMeal] }
//   "detail" { meal }                    -> { ingredients: [{ name, qty }], steps: [...] }
//
// foods: [{ name, weeklyProtein }]  (the user's own food names and the protein grams the plan gives them)
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
const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function cleanFoods(input) {
  const out = [], seen = new Set();
  for (const f of Array.isArray(input) ? input.slice(0, 8) : []) {
    const name = clean(f?.name, 60);
    const weekly = Number(f?.weeklyProtein);
    const nutrition = lookupProtein(name);
    if (!name || !nutrition || !(weekly > 0) || weekly > 50000 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const isCount = nutrition.unit === "count";
    const weeklyAmount = isCount ? weekly / nutrition.proteinPerUnit : (weekly / nutrition.proteinPer100g) * 100;
    out.push({ name, isCount, nutrition, weeklyAmount });
  }
  return out;
}

const proteinOf = (f, amount) => (f.isCount ? amount * f.nutrition.proteinPerUnit : (amount / 100) * f.nutrition.proteinPer100g);

// Turns one model-written meal into a safe, validated meal with protein computed from our own table.
function sanitizeMeal(m, foods) {
  const byName = new Map(foods.map((f) => [f.name.toLowerCase(), f]));
  const merged = new Map();
  for (const it of Array.isArray(m?.items) ? m.items : []) {
    const f = byName.get(String(it?.food ?? "").toLowerCase().trim());
    let amount = Number(it?.amount);
    if (!f || !(amount > 0)) continue;
    amount = f.isCount ? Math.min(30, Math.round(amount * 2) / 2) : Math.min(2000, Math.round(amount / 5) * 5);
    if (amount <= 0) continue;
    merged.set(f.name, (merged.get(f.name) || 0) + amount);
  }
  const items = [...merged].map(([name, amount]) => {
    const f = byName.get(name.toLowerCase());
    const qty = f.isCount ? String(amount) : `${amount} g (${(amount / G_PER_OZ).toFixed(1)} oz)`;
    return { food: name, amount, qty, label: f.isCount ? `${amount} ${name}` : `${qty} ${name}`, protein: Math.round(proteinOf(f, amount)) };
  });
  if (!items.length) return null;
  const title = clean(m?.title, 80);
  if (!title) return null;
  const minutes = Math.max(5, Math.min(180, Math.round(Number(m?.minutes)) || 30));
  const extras = (Array.isArray(m?.extras) ? m.extras : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 6);
  return {
    title,
    summary: clean(m?.summary, 220),
    minutes,
    items,
    extras,
    protein: items.reduce((s, i) => s + i.protein, 0),
  };
}

async function askModel(system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "Model error");
  const out = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
}

const MEAL_SYSTEM = `You plan varied, realistic home cooked meals for one person. The person already bought specific protein foods, and your job is to spread them across meals so they never get bored. Rules:
- Use ONLY the protein foods listed for protein. Never add other meat, fish, eggs, tofu, beans, lentils, protein powder, or dairy protein as a main ingredient.
- Use roughly the listed amount of each food across the meals you write. Not every food has to be in every meal.
- "extras" are simple, cheap, low protein staples (rice, pasta, bread, tortillas, potatoes, oats, fruit, vegetables, oil, sauces, spices). Keep each extra a short plain grocery term like "frozen broccoli". No more than 5 per meal.
- "food" must be copied exactly from the list. "amount" is grams of that food as bought for weight foods, or a plain number for count foods like eggs.
- Never mention protein, calories, or any nutrition numbers. Never mention prices or brands.
- Meals must differ from each other in flavor and style.
Respond with ONLY JSON, no markdown: {"meals":[{"title":str,"summary":str,"minutes":number,"items":[{"food":str,"amount":number}],"extras":[str]}]}
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
    if (!foods.length) return res(400, { error: "Your plan has no foods with protein estimates to build meals from." });
    const perDay = b.mealsPerDay === 2 ? 2 : 3;
    const cook = COOK[b.cookTime] ? b.cookTime : "normal";

    if (b.action === "day") {
      const i = Math.max(0, Math.min(6, Math.round(Number(b.dayIndex)) || 0));
      const user = `Plan ${perDay} meals for day ${i + 1} of 7.
Style for the day: ${THEMES[i % THEMES.length]}.
${COOK[cook]}
Protein foods to spread across the day's meals:
${foodLines(foods)}`;
      const out = await askModel(MEAL_SYSTEM, user, 1100);
      const meals = (Array.isArray(out.meals) ? out.meals : []).map((m) => sanitizeMeal(m, foods)).filter(Boolean).slice(0, perDay);
      if (!meals.length) return res(502, { error: "Could not plan this day. Try again." });
      return res(200, { meals, dayProtein: meals.reduce((s, m) => s + m.protein, 0) });
    }

    if (b.action === "swap") {
      const old = sanitizeMeal(b.meal, foods);
      if (!old) return res(400, { error: "Missing meal to swap" });
      const avoid = (Array.isArray(b.avoid) ? b.avoid : []).map((t) => clean(t, 80)).filter(Boolean).slice(0, 30);
      const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
      const user = `Write exactly 1 replacement meal. Style: ${theme}.
${COOK[cook]}
Use these protein foods in these exact amounts:
${old.items.map((it) => `- ${it.food}: ${it.amount}${foods.find((f) => f.name === it.food)?.isCount ? " (count)" : " g"}`).join("\n")}
Do not reuse any of these meal titles: ${avoid.join("; ") || "none"}`;
      const out = await askModel(MEAL_SYSTEM, user, 500);
      const meal = sanitizeMeal((Array.isArray(out.meals) ? out.meals : [])[0], foods);
      if (!meal) return res(502, { error: "Could not find a swap. Try again." });
      return res(200, { meals: [meal] });
    }

    if (b.action === "detail") {
      const m = sanitizeMeal(b.meal, foods);
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
      return res(200, { ingredients, steps });
    }

    return res(400, { error: "Unknown action" });
  } catch (e) {
    return res(500, { error: "Could not build meal ideas. Try again." });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
