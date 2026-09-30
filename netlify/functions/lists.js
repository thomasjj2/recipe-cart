// POST { idToken, action, ... } -> the signed-in user's saved ingredient lists.
// Actions:
//   "list"                            -> { lists: [{ id, title, ingredients, steps?, createdAt }] }
//   "save"   { title, ingredients, steps? } -> { id }   (steps = the saved meal's short recipe, optional)
//   "delete" { id }                   -> { deleted: true }
//   "deleteAccount"                   -> deletes all lists, the Kroger connection, and the sign-in account
// We store ONLY the user's own list title, ingredient names, quantities, and (for saved meals) the recipe steps.
// No Kroger product, price, or image data is ever saved here (Kroger ToS Section 5e).
const { getAdmin } = require("./_firebaseAdmin");

const MAX_LISTS = 50;
const MAX_ITEMS = 40;
const MAX_STEPS = 6;
const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

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
      const snap = await col.orderBy("createdAt", "desc").limit(MAX_LISTS).get();
      return res(200, { lists: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
    }

    if (b.action === "save") {
      const ingredients = (Array.isArray(b.ingredients) ? b.ingredients : [])
        .map((i) => ({ name: clean(i?.name, 100), qty: clean(i?.qty, 50) }))
        .filter((i) => i.name)
        .slice(0, MAX_ITEMS);
      if (!ingredients.length) return res(400, { error: "There are no ingredients to save." });

      const steps = (Array.isArray(b.steps) ? b.steps : []).map((t) => clean(t, 300)).filter(Boolean).slice(0, MAX_STEPS);

      const count = (await col.count().get()).data().count;
      if (count >= MAX_LISTS) {
        return res(409, { error: `You have ${MAX_LISTS} saved lists. Delete one to save another.` });
      }
      const ref = await col.add({
        title: clean(b.title, 100) || "Shopping list",
        ingredients,
        ...(steps.length ? { steps } : {}),
        createdAt: Date.now(),
      });
      return res(200, { id: ref.id });
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
