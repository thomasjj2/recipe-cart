// POST { idToken, action, ... } -> the signed-in user's saved ingredient lists.
// Actions:
//   "list"                            -> { lists: [{ id, title, ingredients, steps?, createdAt }] }
//   "save"   { title, ingredients, steps?, servings?, proteinPerServing? } -> { id }   (steps = the saved meal's short recipe, optional)
//   "save"   { own: true, title, ingredients, notes?, emoji? } -> { id }   (a meal the person wrote themselves, shown under My Meals)
//   "setNutrition" { id, servings, proteinPerServing } -> { updated: true }   (fills in nutrition for an older saved list)
//   "delete" { id }                   -> { deleted: true }
//   "deleteAccount"                   -> deletes all lists, the Kroger connection, and the sign-in account
// We store ONLY the user's own list title, ingredient names, quantities, servings, estimated protein per serving, and (for saved meals) the recipe steps.
// For My Meals we also store the person's own recipe notes and an icon.
// No Kroger product, price, or image data is ever saved here (Kroger ToS Section 5e).
const { getAdmin } = require("./_firebaseAdmin");

const MAX_LISTS = 50;
const MAX_OWN = 50; // My Meals are counted separately from saved meals
const MAX_NOTES = 500;
const MAX_ITEMS = 40;
const MAX_STEPS = 10;
const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const cleanNotes = (v) => String(v ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_NOTES);
const cleanEmoji = (v) => { const e = clean(v, 8); return /\p{Extended_Pictographic}/u.test(e) ? e : ""; };
const intIn = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }
  if (!b.idToken) return res(401, { error: "Not signed in" });

  try {
    const admin = getAdmin();
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(b.idToken); }
    catch { return res(401, { error: "Please sign in again." }); }

    const db = admin.firestore();
    const userRef = db.collection("users").doc(decoded.uid);
    const col = userRef.collection("lists");

    if (b.action === "list") {
      const snap = await col.orderBy("createdAt", "desc").limit(MAX_LISTS + MAX_OWN).get();
      return res(200, { lists: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
    }

    if (b.action === "save") {
      const ingredients = (Array.isArray(b.ingredients) ? b.ingredients : [])
        .map((i) => ({ name: clean(i?.name, 100), qty: clean(i?.qty, 50) }))
        .filter((i) => i.name)
        .slice(0, MAX_ITEMS);
      if (!ingredients.length) return res(400, { error: "There are no ingredients to save." });

      const steps = (Array.isArray(b.steps) ? b.steps : []).map((t) => clean(t, 400)).filter(Boolean).slice(0, MAX_STEPS);

      const servings = intIn(b.servings, 1, 50);
      const proteinPerServing = intIn(b.proteinPerServing, 0, 500);

      const isOwn = b.own === true;
      const total = (await col.count().get()).data().count;
      const ownCount = (await col.where("own", "==", true).count().get()).data().count;
      if (isOwn && ownCount >= MAX_OWN) {
        return res(409, { error: `You have ${MAX_OWN} of your own meals. Delete one to add another.` });
      }
      if (!isOwn && total - ownCount >= MAX_LISTS) {
        return res(409, { error: `You have ${MAX_LISTS} saved lists. Delete one to save another.` });
      }
      const notes = isOwn ? cleanNotes(b.notes) : "";
      const emoji = isOwn ? cleanEmoji(b.emoji) : "";
      const ref = await col.add({
        title: clean(b.title, 100) || "Shopping list",
        ingredients,
        ...(isOwn ? { own: true } : {}),
        ...(notes ? { notes } : {}),
        ...(emoji ? { emoji } : {}),
        ...(steps.length ? { steps } : {}),
        ...(servings ? { servings } : {}),
        ...(servings && proteinPerServing !== null ? { proteinPerServing } : {}),
        createdAt: Date.now(),
      });
      return res(200, { id: ref.id });
    }

    if (b.action === "setNutrition") {
      if (typeof b.id !== "string" || !b.id || b.id.includes("/")) return res(400, { error: "Missing list id" });
      const servings = intIn(b.servings, 1, 50);
      const proteinPerServing = intIn(b.proteinPerServing, 0, 500);
      if (!servings || proteinPerServing === null) return res(400, { error: "Missing servings or protein" });
      const ref = col.doc(b.id);
      if (!(await ref.get()).exists) return res(404, { error: "That list no longer exists." });
      await ref.update({ servings, proteinPerServing });
      return res(200, { updated: true });
    }

    if (b.action === "delete") {
      if (typeof b.id !== "string" || !b.id || b.id.includes("/")) return res(400, { error: "Missing list id" });
      await col.doc(b.id).delete();
      return res(200, { deleted: true });
    }

    if (b.action === "deleteAccount") {
      // Removes the user doc (including the stored Kroger refresh token) and all lists under it.
      await db.recursiveDelete(userRef);
      await admin.auth().deleteUser(decoded.uid);
      return res(200, { deleted: true });
    }

    return res(400, { error: "Unknown action" });
  } catch (e) {
    return res(500, { error: e.message || "Something went wrong with your lists" });
  }
};
const res = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
