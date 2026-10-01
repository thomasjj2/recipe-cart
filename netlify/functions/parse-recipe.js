// POST { text } -> { title, servings, servingsEstimated, proteinPerServing, ingredients: [{ name, qty }] }
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const SYSTEM = `Extract a shopping list from recipe or meal-plan text. Combine duplicate ingredients across recipes.
Respond with ONLY JSON, no markdown: {"title":str,"servings":int,"servingsEstimated":bool,"proteinPerServing":int,"ingredients":[{"name":str,"qty":str}]}
"servings" is how many servings the whole text makes in total. Use the stated yield if there is one and set "servingsEstimated" to false. If none is stated, work it out from the amounts (for example about 4 oz of cooked meat per person, 3 small tacos per person) and set "servingsEstimated" to true.
"proteinPerServing" is your best estimate of grams of protein in one serving, as a whole number, based on the ingredient amounts and servings.
"name" should be a plain grocery search term (e.g. "chicken breast", not "2 boneless skinless chicken breasts, diced"). Put quantity/unit info in "qty" (e.g. "2 lbs"). Skip pantry staples like water or salt unless clearly a shopping item.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return res(500, { error: "Missing ANTHROPIC_API_KEY" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }
  const text = (b.text || "").slice(0, 6000);
  if (!text.trim()) return res(400, { error: "Paste a recipe or meal plan first" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1400, system: SYSTEM, messages: [{ role: "user", content: text }] }),
    });
    const data = await r.json();
    if (!r.ok) return res(502, { error: data.error?.message || "Model error" });
    const out = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    const out2 = JSON.parse(json);
    const num = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
    out2.servings = num(out2.servings, 1, 50);
    out2.proteinPerServing = num(out2.proteinPerServing, 0, 200);
    out2.servingsEstimated = out2.servingsEstimated !== false;
    return res(200, out2);
  } catch (e) {
    return res(500, { error: "Could not parse that recipe. Try again." });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
