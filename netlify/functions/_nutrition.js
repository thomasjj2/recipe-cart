// Protein reference values, corrected to match how Kroger actually SELLS each food —
// not generic "cooked" nutrition-label values. This matters: Kroger sells raw chicken
// breast by raw weight, but cooking concentrates protein (water cooks off), so a
// "cooked" per-100g figure applied to a raw package weight overstates how much food
// you actually need to buy. Each entry here is as-purchased basis.
//
// unit: "weight" (priced/sized by lb/oz/kg) or "count" (priced/sized by item, e.g. eggs).
// confidence: "high" = stable, well-established value. "moderate"/"low" = real product
// variation (fat trim, bone-in vs out, canned vs dry) makes this a rougher estimate —
// surfaced in the UI so it isn't presented with false precision.
const PROTEIN_SOURCES = [
  { keywords: ["rotisserie chicken", "rotisserie"], label: "Rotisserie chicken (whole)", unit: "weight",
    proteinPer100g: 12, confidence: "moderate", note: "Whole bird incl. bone/skin — actual edible yield varies." },
  { keywords: ["chicken breast"], label: "Chicken breast (raw)", unit: "weight",
    proteinPer100g: 23, confidence: "high" },
  { keywords: ["chicken thigh"], label: "Chicken thigh (raw, boneless)", unit: "weight",
    proteinPer100g: 18, confidence: "moderate", note: "Lower if bone-in." },
  { keywords: ["ground turkey"], label: "Ground turkey (raw)", unit: "weight",
    proteinPer100g: 19, confidence: "high" },
  { keywords: ["turkey breast"], label: "Turkey breast (raw)", unit: "weight",
    proteinPer100g: 22, confidence: "moderate" },
  { keywords: ["ground beef 93", "93/7", "lean ground beef"], label: "Lean ground beef 93/7 (raw)", unit: "weight",
    proteinPer100g: 19, confidence: "high" },
  { keywords: ["ground beef 80", "80/20", "ground beef"], label: "Ground beef 80/20 (raw)", unit: "weight",
    proteinPer100g: 17, confidence: "high" },
  { keywords: ["steak", "sirloin", "flank steak"], label: "Beef steak (raw)", unit: "weight",
    proteinPer100g: 21, confidence: "moderate", note: "Varies by cut." },
  { keywords: ["pork tenderloin", "pork loin"], label: "Pork tenderloin (raw)", unit: "weight",
    proteinPer100g: 20, confidence: "high" },
  { keywords: ["pork chop"], label: "Pork chop (raw)", unit: "weight",
    proteinPer100g: 18, confidence: "moderate", note: "Lower if bone-in." },
  { keywords: ["salmon"], label: "Salmon (raw)", unit: "weight",
    proteinPer100g: 20, confidence: "high" },
  { keywords: ["tilapia", "cod", "white fish"], label: "White fish (raw)", unit: "weight",
    proteinPer100g: 18, confidence: "high" },
  { keywords: ["shrimp"], label: "Shrimp (raw, peeled)", unit: "weight",
    proteinPer100g: 18, confidence: "moderate" },
  { keywords: ["tofu"], label: "Tofu (firm, as packaged)", unit: "weight",
    proteinPer100g: 12, confidence: "high" },
  { keywords: ["egg"], label: "Eggs (large)", unit: "count",
    proteinPerUnit: 6, confidence: "high" },
  { keywords: ["greek yogurt", "greek yoghurt"], label: "Greek yogurt, plain nonfat (as packaged)", unit: "weight",
    proteinPer100g: 10, confidence: "high" },
  { keywords: ["black bean", "beans"], label: "Black beans, canned (as packaged, incl. liquid)", unit: "weight",
    proteinPer100g: 5, confidence: "low", note: "Dry beans are ~4x denser per 100g — this assumes canned." },
  { keywords: ["lentil"], label: "Lentils, canned/pouch (as packaged)", unit: "weight",
    proteinPer100g: 5, confidence: "low", note: "Dry lentils are much denser per 100g — this assumes ready-to-eat." },
  { keywords: ["cottage cheese"], label: "Cottage cheese (as packaged)", unit: "weight",
    proteinPer100g: 11, confidence: "high" },
];

function lookupProtein(term) {
  const t = String(term || "").toLowerCase();
  for (const entry of PROTEIN_SOURCES) {
    if (entry.keywords.some((k) => t.includes(k))) return entry;
  }
  return null;
}

module.exports = { PROTEIN_SOURCES, lookupProtein };
