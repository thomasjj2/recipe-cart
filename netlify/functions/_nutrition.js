// Reference values per food, on the as purchased basis Kroger sells it (raw weight, packaged weight).
// Each entry has protein and calories. Weight foods use per 100g values, count foods (eggs) use per unit.
// confidence: "high" is stable. "moderate" or "low" means real product variation, shown in the UI as an estimate.
//
// FOOD CARDS: an entry with a `category` is shown as a tap to select card in the app. Fields used for cards:
//   searchTerm  the exact string the app sends as a preference. It is also the Kroger search query, and it
//               must resolve back to this same entry through lookupProtein() (checked by validateCatalog()).
//   category    Proteins, Dairy, Carbs, Fats, Snacks, or Produce.
//   emoji       our own icon for the card (never a Kroger image).
//   mustHave / mustNot  guard words for the Kroger product name. A search for "Ground beef 93/7" can return ground turkey,
//               so a card's results are kept only if the name has one of the mustHave words and none of the mustNot words.
//               The guard applies to cards only, never to typed foods.
//   cartOnly    true for low calorie produce. The planner skips these in the protein and calorie steps and in
//               meal weighting, but still puts one package in the cart.
// Entries with no category (turkey breast, pork chop, white fish, lentils, generic veg and fruit) have no card,
// but still match typed foods. `exclude` lists words that stop a keyword match (almond milk is not milk).
const PROTEIN_SOURCES = [
  // ---- Proteins ----
  { keywords: ["chicken breast"], label: "Chicken breast (raw)", unit: "weight",
    proteinPer100g: 23, caloriesPer100g: 120, confidence: "high",
    category: "Proteins", searchTerm: "Chicken breast", mustHave: ["chicken"], mustNot: ["turkey", "beef", "pork", "pet"], emoji: "🍗" },
  { keywords: ["chicken thigh"], label: "Chicken thigh (raw, boneless)", unit: "weight",
    proteinPer100g: 18, caloriesPer100g: 125, confidence: "moderate", note: "Lower if bone-in.",
    category: "Proteins", searchTerm: "Chicken thighs", mustHave: ["chicken"], mustNot: ["turkey", "beef", "pork", "pet"], emoji: "🍗" },
  { keywords: ["rotisserie chicken", "rotisserie"], label: "Rotisserie chicken (whole)", unit: "weight",
    proteinPer100g: 12, caloriesPer100g: 140, confidence: "moderate", note: "Whole bird incl. bone/skin, actual edible yield varies.",
    category: "Proteins", searchTerm: "Rotisserie chicken", mustHave: ["chicken"], mustNot: ["turkey", "beef", "pork", "soup", "salad"], emoji: "🐔" },
  { keywords: ["ground beef 80", "80/20"], label: "Ground beef 80/20 (raw)", unit: "weight",
    proteinPer100g: 17, caloriesPer100g: 254, confidence: "high",
    category: "Proteins", searchTerm: "Ground beef 80/20", mustHave: ["beef"], mustNot: ["turkey", "chicken", "pork", "plant", "jerky"], emoji: "🍔" },
  { keywords: ["ground beef 93", "93/7", "lean ground beef"], label: "Lean ground beef 93/7 (raw)", unit: "weight",
    proteinPer100g: 19, caloriesPer100g: 150, confidence: "high",
    category: "Proteins", searchTerm: "Ground beef 93/7", mustHave: ["beef"], mustNot: ["turkey", "chicken", "pork", "plant", "jerky"], emoji: "🥩" },
  { keywords: ["ground beef"], label: "Ground beef 80/20 (raw)", unit: "weight",
    proteinPer100g: 17, caloriesPer100g: 254, confidence: "high", note: "Counted as 80/20 ground beef." },
  { keywords: ["steak", "sirloin", "flank steak", "shaved beef", "beef"], label: "Beef steak (raw)", unit: "weight",
    proteinPer100g: 21, caloriesPer100g: 160, confidence: "moderate", note: "Varies by cut.",
    category: "Proteins", searchTerm: "Sirloin steak", mustHave: ["sirloin"], mustNot: ["pork", "chicken", "turkey"], emoji: "🥩" },
  { keywords: ["pork tenderloin", "pork loin"], label: "Pork tenderloin (raw)", unit: "weight",
    proteinPer100g: 20, caloriesPer100g: 120, confidence: "high",
    category: "Proteins", searchTerm: "Pork tenderloin", mustHave: ["pork"], mustNot: ["sausage", "bacon"], emoji: "🥓" },
  { keywords: ["pork chop"], label: "Pork chop (raw)", unit: "weight",
    proteinPer100g: 18, caloriesPer100g: 150, confidence: "moderate", note: "Lower if bone-in." },
  { keywords: ["ground turkey"], label: "Ground turkey (raw)", unit: "weight",
    proteinPer100g: 19, caloriesPer100g: 150, confidence: "high",
    category: "Proteins", searchTerm: "Ground turkey", mustHave: ["turkey"], mustNot: ["bacon", "sausage", "deli", "lunch"], emoji: "🦃" },
  { keywords: ["turkey breast"], label: "Turkey breast (raw)", unit: "weight",
    proteinPer100g: 22, caloriesPer100g: 110, confidence: "moderate" },
  { keywords: ["salmon"], label: "Salmon (raw)", unit: "weight",
    proteinPer100g: 20, caloriesPer100g: 200, confidence: "high",
    category: "Proteins", searchTerm: "Salmon fillet", mustHave: ["salmon"], mustNot: ["canned", "pouch", "smoked", "burger", "dog food", "cat food"], emoji: "🐟" },
  { keywords: ["tilapia", "cod", "white fish"], label: "White fish (raw)", unit: "weight",
    proteinPer100g: 18, caloriesPer100g: 90, confidence: "high" },
  { keywords: ["shrimp"], label: "Shrimp (raw, peeled)", unit: "weight",
    proteinPer100g: 18, caloriesPer100g: 85, confidence: "moderate",
    category: "Proteins", searchTerm: "Shrimp", mustHave: ["shrimp"], mustNot: ["chip", "cracker", "ramen"], emoji: "🦐" },
  { keywords: ["tuna"], label: "Canned tuna in water (as packaged)", unit: "weight",
    proteinPer100g: 22, caloriesPer100g: 100, confidence: "moderate", note: "Net weight includes the water.",
    category: "Proteins", searchTerm: "Canned tuna", mustHave: ["tuna"], mustNot: ["salad kit", "cat food", "dog food"], emoji: "🥫" },
  { keywords: ["egg"], exclude: ["eggplant"], label: "Eggs (large)", unit: "count",
    proteinPerUnit: 6, caloriesPerUnit: 72, confidence: "high",
    category: "Proteins", searchTerm: "Eggs", mustHave: ["egg"], mustNot: ["eggplant", "eggnog", "noodle", "substitute"], emoji: "🥚" },
  { keywords: ["tofu"], label: "Tofu (firm, as packaged)", unit: "weight",
    proteinPer100g: 12, caloriesPer100g: 120, confidence: "high",
    category: "Proteins", searchTerm: "Tofu", mustHave: ["tofu"], mustNot: ["sauce"], emoji: "⬜" },
  { keywords: ["black bean", "beans"], exclude: ["green bean", "string bean"], label: "Black beans, canned (as packaged, incl. liquid)", unit: "weight",
    proteinPer100g: 5, caloriesPer100g: 85, confidence: "low", note: "Dry beans are about 4x denser per 100g, this assumes canned.",
    category: "Proteins", searchTerm: "Black beans", mustHave: ["bean"], mustNot: ["green bean", "coffee", "jelly"], emoji: "🫘" },
  { keywords: ["lentil"], label: "Lentils, canned/pouch (as packaged)", unit: "weight",
    proteinPer100g: 5, caloriesPer100g: 95, confidence: "low", note: "Dry lentils are much denser per 100g, this assumes ready to eat." },
  // ---- Dairy ----
  { keywords: ["greek yogurt", "greek yoghurt"], label: "Greek yogurt, plain nonfat (as packaged)", unit: "weight",
    proteinPer100g: 10, caloriesPer100g: 59, confidence: "high",
    category: "Dairy", searchTerm: "Greek yogurt", mustHave: ["yogurt", "yoghurt"], mustNot: ["dressing", "frozen"], emoji: "🥣" },
  { keywords: ["cottage cheese"], label: "Cottage cheese (as packaged)", unit: "weight",
    proteinPer100g: 11, caloriesPer100g: 98, confidence: "high",
    category: "Dairy", searchTerm: "Cottage cheese", mustHave: ["cottage"], mustNot: [], emoji: "🥄" },
  { keywords: ["whole milk", "2% milk", "milk"], exclude: ["almond", "oat", "soy", "coconut", "cashew", "chocolate", "condensed", "buttermilk"],
    label: "Whole milk", unit: "weight", proteinPer100g: 3.3, caloriesPer100g: 61, confidence: "high", note: "Sold by volume, converted to weight.",
    category: "Dairy", searchTerm: "Whole milk", mustHave: ["milk"], mustNot: ["almond", "oat", "soy", "coconut", "cashew", "chocolate", "condensed", "buttermilk", "evaporated"], emoji: "🥛" },
  { keywords: ["cheddar", "shredded cheese"], label: "Shredded cheddar cheese", unit: "weight",
    proteinPer100g: 25, caloriesPer100g: 403, confidence: "high",
    category: "Dairy", searchTerm: "Shredded cheddar cheese", mustHave: ["cheddar", "cheese"], mustNot: ["cottage", "cream cheese", "sauce", "dip", "mac"], emoji: "🧀" },
  // ---- Carbs ----
  { keywords: ["rice"], label: "Rice (dry)", unit: "weight",
    proteinPer100g: 7, caloriesPer100g: 365, confidence: "high", note: "Dry weight.",
    category: "Carbs", searchTerm: "Rice", mustHave: ["rice"], mustNot: ["krispies", "cake", "cracker", "vinegar", "pudding", "cereal", "chex", "noodle", "milk", "chip", "seasoning", "wine", "paper"], emoji: "🍚" },
  { keywords: ["pasta", "spaghetti", "penne", "macaroni"], label: "Pasta (dry)", unit: "weight",
    proteinPer100g: 13, caloriesPer100g: 371, confidence: "high", note: "Dry weight.",
    category: "Carbs", searchTerm: "Pasta", mustHave: ["pasta", "spaghetti", "penne", "macaroni", "fettuccine", "rotini", "linguine", "rigatoni", "noodle"], mustNot: ["sauce", "salad", "soup", "dinner kit"], emoji: "🍝" },
  { keywords: ["oats", "oatmeal"], label: "Oats (dry)", unit: "weight",
    proteinPer100g: 13, caloriesPer100g: 389, confidence: "high", note: "Dry weight.",
    category: "Carbs", searchTerm: "Old fashioned oats", mustHave: ["oat"], mustNot: ["milk", "cereal", "cookie", "bar", "cheerios", "creamer"], emoji: "🌾" },
  { keywords: ["bread"], label: "Sandwich bread", unit: "weight",
    proteinPer100g: 9, caloriesPer100g: 265, confidence: "moderate",
    category: "Carbs", searchTerm: "Sandwich bread", mustHave: ["bread"], mustNot: ["crumb", "pudding", "stuffing", "dough"], emoji: "🍞" },
  { keywords: ["tortilla"], label: "Flour tortillas", unit: "weight",
    proteinPer100g: 8, caloriesPer100g: 300, confidence: "moderate",
    category: "Carbs", searchTerm: "Flour tortillas", mustHave: ["tortilla"], mustNot: ["chip", "soup"], emoji: "🫓" },
  { keywords: ["potato"], label: "Potatoes (raw)", unit: "weight",
    proteinPer100g: 2, caloriesPer100g: 77, confidence: "high",
    category: "Carbs", searchTerm: "Russet potatoes", mustHave: ["potato"], mustNot: ["chip", "fries", "tots", "salad", "mashed", "soup"], emoji: "🥔" },
  // ---- Fats ----
  { keywords: ["olive oil", "vegetable oil", "canola oil", "cooking oil"], label: "Cooking oil", unit: "weight",
    proteinPer100g: 0, caloriesPer100g: 884, confidence: "high", note: "Fluid ounces are converted to weight.",
    category: "Fats", searchTerm: "Olive oil", mustHave: ["oil"], mustNot: ["spray", "dressing", "sardine", "tuna", "packed", "filter"], emoji: "🫒" },
  { keywords: ["peanut butter"], label: "Peanut butter", unit: "weight",
    proteinPer100g: 25, caloriesPer100g: 588, confidence: "high",
    category: "Fats", searchTerm: "Peanut butter", mustHave: ["peanut"], mustNot: ["cup", "cookie", "bar", "cracker", "pretzel", "filled", "m&m", "cereal"], emoji: "🥜" },
  { keywords: ["butter"], exclude: ["peanut", "almond", "cashew", "nut", "milk", "bean", "squash", "cookie"], label: "Butter", unit: "weight",
    proteinPer100g: 0.9, caloriesPer100g: 717, confidence: "high",
    category: "Fats", searchTerm: "Butter", mustHave: ["butter"], mustNot: ["peanut", "almond", "cashew", "cookie", "cracker", "popcorn", "bean", "squash", "cup", "milk", "spread"], emoji: "🧈" },
  // ---- Snacks ----
  { keywords: ["almonds"], label: "Almonds", unit: "weight",
    proteinPer100g: 21, caloriesPer100g: 579, confidence: "high",
    category: "Snacks", searchTerm: "Almonds", mustHave: ["almond"], mustNot: ["milk", "butter", "creamer", "bar", "cereal"], emoji: "🌰" },
  { keywords: ["granola"], label: "Granola bars", unit: "weight",
    proteinPer100g: 10, caloriesPer100g: 450, confidence: "low", note: "Varies a lot by brand.",
    category: "Snacks", searchTerm: "Granola bars", mustHave: ["granola"], mustNot: ["cereal", "clusters"], emoji: "🍫" },
  { keywords: ["protein bar"], label: "Protein bars", unit: "weight",
    proteinPer100g: 30, caloriesPer100g: 350, confidence: "low", note: "Varies a lot by brand.",
    category: "Snacks", searchTerm: "Protein bars", mustHave: ["bar"], mustNot: ["shake", "powder", "candy", "granola"], emoji: "💪" },
  // ---- Produce (cart only: planner skips these, they still go in the cart) ----
  { keywords: ["tomato"], label: "Tomatoes", unit: "weight", proteinPer100g: 0.9, caloriesPer100g: 18, confidence: "high",
    cartOnly: true, category: "Produce", searchTerm: "Tomatoes", mustHave: ["tomato"], mustNot: ["sauce", "paste", "soup", "juice", "ketchup", "salsa"], emoji: "🍅" },
  { keywords: ["spinach"], label: "Spinach", unit: "weight", proteinPer100g: 2.9, caloriesPer100g: 23, confidence: "high",
    cartOnly: true, category: "Produce", searchTerm: "Spinach", mustHave: ["spinach"], mustNot: ["dip", "pizza", "soup"], emoji: "🥬" },
  { keywords: ["broccoli"], label: "Broccoli", unit: "weight", proteinPer100g: 2.8, caloriesPer100g: 34, confidence: "high",
    cartOnly: true, category: "Produce", searchTerm: "Broccoli", mustHave: ["broccoli"], mustNot: ["cheese", "soup"], emoji: "🥦" },
  { keywords: ["carrot"], label: "Carrots", unit: "weight", proteinPer100g: 0.9, caloriesPer100g: 41, confidence: "high",
    cartOnly: true, category: "Produce", searchTerm: "Carrots", mustHave: ["carrot"], mustNot: ["cake", "juice"], emoji: "🥕" },
  { keywords: ["bell pepper", "peppers"], label: "Bell peppers", unit: "weight", proteinPer100g: 1, caloriesPer100g: 26, confidence: "high",
    cartOnly: true, category: "Produce", searchTerm: "Bell peppers", mustHave: ["pepper"], mustNot: ["black pepper", "ground pepper", "pepper jack", "dr pepper", "sauce", "seasoning"], emoji: "🫑" },
  { keywords: ["onion"], label: "Onions", unit: "weight", proteinPer100g: 1.1, caloriesPer100g: 40, confidence: "high",
    cartOnly: true, category: "Produce", searchTerm: "Yellow onions", mustHave: ["onion"], mustNot: ["ring", "powder", "dip", "soup"], emoji: "🧅" },
  // Generic produce for typed foods. No card. Cart only.
  { keywords: ["lettuce", "cucumber", "celery", "zucchini", "mushroom", "cabbage", "kale", "cauliflower", "green bean", "asparagus", "salad", "vegetable"],
    label: "Vegetables", unit: "weight", proteinPer100g: 2, caloriesPer100g: 25, confidence: "moderate", cartOnly: true },
  { keywords: ["apple", "banana", "orange", "berries", "berry", "strawberr", "grapes", "lemon", "lime", "fruit"],
    label: "Fruit", unit: "weight", proteinPer100g: 1, caloriesPer100g: 55, confidence: "moderate", cartOnly: true },
];

// True when a Kroger product name is a plausible match for this card's food. Entries without guard words always pass.
function matchesFood(entry, productName) {
  const d = String(productName || "").toLowerCase();
  if (entry?.mustHave?.length && !entry.mustHave.some((w) => d.includes(w))) return false;
  if (entry?.mustNot?.length && entry.mustNot.some((w) => d.includes(w))) return false;
  return true;
}

// Typed foods that are too vague to match (just "chicken"). They are counted as a sensible default and shown as a rough estimate.
const FALLBACKS = [
  [/\bchicken\b/, "chicken breast"], [/\bpork\b/, "pork chop"], [/\bturkey\b/, "ground turkey"], [/\bfish\b/, "white fish"],
  [/\bcheese\b/, "cheddar"], [/\byogurt\b/, "greek yogurt"], [/\bnuts?\b/, "almonds"],
];

function matchEntry(t) {
  for (const entry of PROTEIN_SOURCES) {
    if (entry.exclude && entry.exclude.some((x) => t.includes(x))) continue;
    if (entry.keywords.some((k) => t.includes(k))) return entry;
  }
  return null;
}

function lookupProtein(term) {
  const t = String(term || "").toLowerCase();
  const exact = matchEntry(t);
  if (exact) return exact;
  for (const [re, as] of FALLBACKS) {
    if (re.test(t)) {
      const e = matchEntry(as);
      if (e) return { ...e, confidence: "low", note: `Counted as ${e.label.toLowerCase()}.` };
    }
  }
  return null;
}

// ---- Planning rules shared by the planner (protein-plan.js) and the app's feasibility meter ----
const PLANNING = {
  PROTEIN_DENSE: 0.2,     // on a calorie goal the protein step only uses foods with 20%+ of calories from protein
  CAL_SHARE: 0.4,         // no single food covers more than 40% of the calorie goal
  CAL_SHARE_DENSE: 0.2,   // oils and nut butters (500+ cal per 100g) cover at most 20%
  CAL_SHARE_LIGHT: 0.25,  // low calorie foods (under 150 cal per 100g, and eggs) cover at most 25%
  MAX_SHARE_PER_ITEM: 0.65, // ranked protein step: no single food covers more than 65% of the protein goal
};
const calShareFor = (n) => {
  if (!n) return PLANNING.CAL_SHARE;
  if (n.unit === "count") return PLANNING.CAL_SHARE_LIGHT;
  const d = n.caloriesPer100g ?? 0;
  return d >= 500 ? PLANNING.CAL_SHARE_DENSE : d < 150 ? PLANNING.CAL_SHARE_LIGHT : PLANNING.CAL_SHARE;
};
const isProteinDense = (n) => {
  const p = n.unit === "count" ? n.proteinPerUnit : n.proteinPer100g;
  const c = n.unit === "count" ? n.caloriesPerUnit : n.caloriesPer100g;
  return !!c && (p * 4) / c >= PLANNING.PROTEIN_DENSE;
};

// What the app needs to draw one card. Built from the entries above, so there is no second list to keep in sync.
const CATALOG = PROTEIN_SOURCES.filter((e) => e.category && e.searchTerm).map((e) => ({
  searchTerm: e.searchTerm, category: e.category, emoji: e.emoji, unit: e.unit, confidence: e.confidence, cartOnly: !!e.cartOnly,
  proteinPer100g: e.proteinPer100g ?? null, caloriesPer100g: e.caloriesPer100g ?? null,
  proteinPerUnit: e.proteinPerUnit ?? null, caloriesPerUnit: e.caloriesPerUnit ?? null,
}));

// Every card's searchTerm must resolve back to its own entry. Returns a list of problems (empty means good).
function validateCatalog() {
  const problems = [], seen = new Set();
  for (const e of PROTEIN_SOURCES) {
    if (!e.category) continue;
    const key = e.searchTerm.toLowerCase();
    if (seen.has(key)) problems.push(`duplicate searchTerm: ${e.searchTerm}`);
    seen.add(key);
    if (!matchesFood(e, e.searchTerm)) problems.push(`"${e.searchTerm}" fails its own mustHave or mustNot guard`);
    if (lookupProtein(e.searchTerm) !== e) problems.push(`"${e.searchTerm}" resolves to ${lookupProtein(e.searchTerm)?.label || "nothing"}, not ${e.label}`);
  }
  return problems;
}

module.exports = { PROTEIN_SOURCES, matchesFood, lookupProtein, lookupNutrition: lookupProtein, PLANNING, calShareFor, isProteinDense, CATALOG, validateCatalog };
