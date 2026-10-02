// Reference values per food, on the as purchased basis Kroger sells it (raw weight, packaged weight).
// Each entry has protein and calories. Weight foods use per 100g values, count foods (eggs) use per unit.
// confidence: "high" is stable. "moderate" or "low" means real product variation, shown in the UI as an estimate.
// Staples (rice, pasta, oats, bread, potatoes, oil, peanut butter, tortillas) are here so calorie goals can be met.
const PROTEIN_SOURCES = [
  { keywords: ["rotisserie chicken", "rotisserie"], label: "Rotisserie chicken (whole)", unit: "weight",
    proteinPer100g: 12, caloriesPer100g: 140, confidence: "moderate", note: "Whole bird incl. bone/skin, actual edible yield varies." },
  { keywords: ["chicken breast"], label: "Chicken breast (raw)", unit: "weight",
    proteinPer100g: 23, caloriesPer100g: 120, confidence: "high" },
  { keywords: ["chicken thigh"], label: "Chicken thigh (raw, boneless)", unit: "weight",
    proteinPer100g: 18, caloriesPer100g: 125, confidence: "moderate", note: "Lower if bone-in." },
  { keywords: ["ground turkey"], label: "Ground turkey (raw)", unit: "weight",
    proteinPer100g: 19, caloriesPer100g: 150, confidence: "high" },
  { keywords: ["turkey breast"], label: "Turkey breast (raw)", unit: "weight",
    proteinPer100g: 22, caloriesPer100g: 110, confidence: "moderate" },
  { keywords: ["ground beef 93", "93/7", "lean ground beef"], label: "Lean ground beef 93/7 (raw)", unit: "weight",
    proteinPer100g: 19, caloriesPer100g: 150, confidence: "high" },
  { keywords: ["ground beef 80", "80/20", "ground beef"], label: "Ground beef 80/20 (raw)", unit: "weight",
    proteinPer100g: 17, caloriesPer100g: 254, confidence: "high" },
  { keywords: ["steak", "sirloin", "flank steak", "shaved beef", "beef"], label: "Beef steak (raw)", unit: "weight",
    proteinPer100g: 21, caloriesPer100g: 160, confidence: "moderate", note: "Varies by cut." },
  { keywords: ["pork tenderloin", "pork loin"], label: "Pork tenderloin (raw)", unit: "weight",
    proteinPer100g: 20, caloriesPer100g: 120, confidence: "high" },
  { keywords: ["pork chop"], label: "Pork chop (raw)", unit: "weight",
    proteinPer100g: 18, caloriesPer100g: 150, confidence: "moderate", note: "Lower if bone-in." },
  { keywords: ["salmon"], label: "Salmon (raw)", unit: "weight",
    proteinPer100g: 20, caloriesPer100g: 200, confidence: "high" },
  { keywords: ["tilapia", "cod", "white fish"], label: "White fish (raw)", unit: "weight",
    proteinPer100g: 18, caloriesPer100g: 90, confidence: "high" },
  { keywords: ["shrimp"], label: "Shrimp (raw, peeled)", unit: "weight",
    proteinPer100g: 18, caloriesPer100g: 85, confidence: "moderate" },
  { keywords: ["tofu"], label: "Tofu (firm, as packaged)", unit: "weight",
    proteinPer100g: 12, caloriesPer100g: 120, confidence: "high" },
  { keywords: ["egg"], label: "Eggs (large)", unit: "count",
    proteinPerUnit: 6, caloriesPerUnit: 72, confidence: "high" },
  { keywords: ["greek yogurt", "greek yoghurt"], label: "Greek yogurt, plain nonfat (as packaged)", unit: "weight",
    proteinPer100g: 10, caloriesPer100g: 59, confidence: "high" },
  { keywords: ["black bean", "beans"], label: "Black beans, canned (as packaged, incl. liquid)", unit: "weight",
    proteinPer100g: 5, caloriesPer100g: 85, confidence: "low", note: "Dry beans are about 4x denser per 100g, this assumes canned." },
  { keywords: ["lentil"], label: "Lentils, canned/pouch (as packaged)", unit: "weight",
    proteinPer100g: 5, caloriesPer100g: 95, confidence: "low", note: "Dry lentils are much denser per 100g, this assumes ready to eat." },
  { keywords: ["cottage cheese"], label: "Cottage cheese (as packaged)", unit: "weight",
    proteinPer100g: 11, caloriesPer100g: 98, confidence: "high" },
  // Staples, mostly for calorie goals
  { keywords: ["rice"], label: "Rice (dry)", unit: "weight",
    proteinPer100g: 7, caloriesPer100g: 365, confidence: "high", note: "Dry weight." },
  { keywords: ["pasta", "spaghetti", "penne", "macaroni"], label: "Pasta (dry)", unit: "weight",
    proteinPer100g: 13, caloriesPer100g: 371, confidence: "high", note: "Dry weight." },
  { keywords: ["oats", "oatmeal"], label: "Oats (dry)", unit: "weight",
    proteinPer100g: 13, caloriesPer100g: 389, confidence: "high", note: "Dry weight." },
  { keywords: ["bread"], label: "Sandwich bread", unit: "weight",
    proteinPer100g: 9, caloriesPer100g: 265, confidence: "moderate" },
  { keywords: ["tortilla"], label: "Flour tortillas", unit: "weight",
    proteinPer100g: 8, caloriesPer100g: 300, confidence: "moderate" },
  { keywords: ["potato"], label: "Potatoes (raw)", unit: "weight",
    proteinPer100g: 2, caloriesPer100g: 77, confidence: "high" },
  { keywords: ["peanut butter"], label: "Peanut butter", unit: "weight",
    proteinPer100g: 25, caloriesPer100g: 588, confidence: "high" },
  { keywords: ["olive oil", "vegetable oil", "canola oil", "cooking oil"], label: "Cooking oil", unit: "weight",
    proteinPer100g: 0, caloriesPer100g: 884, confidence: "high", note: "Fluid ounces are converted to weight." },
];

function lookupProtein(term) {
  const t = String(term || "").toLowerCase();
  for (const entry of PROTEIN_SOURCES) {
    if (entry.keywords.some((k) => t.includes(k))) return entry;
  }
  return null;
}

module.exports = { PROTEIN_SOURCES, lookupProtein, lookupNutrition: lookupProtein };
