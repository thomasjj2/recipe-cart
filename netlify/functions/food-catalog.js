// GET -> { foods: [card], planning: {...} }
// The food cards the app shows in its tap to select picker. They are built from the entries in _nutrition.js,
// so there is only one list of foods. `planning` carries the planner's share rules so the app's feasibility meter
// uses the same numbers as protein-plan.js. This is our own static data: no Kroger product, price, size, or image
// data is involved, and nothing is stored.
const { CATALOG, PLANNING } = require("./_nutrition");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "GET only" }) };
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    body: JSON.stringify({ foods: CATALOG, planning: PLANNING }),
  };
};
