// POST { text } -> { title, ingredients: [{ name, qty }] }
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const SYSTEM = `Extract a shopping list from recipe or meal-plan text. Combine duplicate ingredients across recipes.
Respond with ONLY JSON, no markdown: {"title":str,"ingredients":[{"name":str,"qty":str}]}
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
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: SYSTEM, messages: [{ role: "user", content: text }] }),
    });
    const data = await r.json();
    if (!r.ok) return res(502, { error: data.error?.message || "Model error" });
    const out = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    return res(200, JSON.parse(json));
  } catch (e) {
    return res(500, { error: "Could not parse that recipe. Try again." });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
