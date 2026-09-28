# Recipe → Cart (test MVP)

Paste a recipe, get real Kroger prices, one-tap into the user's real Kroger cart.
No price history is stored (Kroger ToS Section 4e forbids that) — every lookup is live,
and the only thing saved server-side is the user's own Kroger refresh token, so we can
act on their cart on their behalf.

## What's here
- `index.html` — the whole frontend (recipe box, list, Firebase Google sign-in)
- `netlify/functions/parse-recipe.js` — Claude turns pasted text into a clean ingredient list
- `netlify/functions/match-products.js` — live Kroger product/price lookup (Client Credentials, no user login needed)
- `netlify/functions/kroger-auth-start.js` / `kroger-auth-callback.js` — one-time "Connect Kroger" OAuth flow (Authorization Code, `cart.basic:write`)
- `netlify/functions/cart-add.js` — pushes matched items into the user's real Kroger cart
- `netlify/functions/_kroger.js` / `_firebaseAdmin.js` — shared helpers

## Setup

### 1. Kroger developer account
1. Register at developer.kroger.com (you've done this).
2. Create a **Public** app. Name it something that doesn't contain "Kroger" (e.g. "Recipe Cart").
3. Add scopes: `product.compact` and `cart.basic:write`.
4. Set the **redirect URI** to `https://YOUR-SITE.netlify.app/.netlify/functions/kroger-auth-callback` (you'll get the real subdomain after your first Netlify deploy — update this in the Kroger dashboard once you know it).
5. Copy the Client ID and Client Secret.

### 2. Firebase
1. Firebase console → enable **Authentication → Google** sign-in method.
2. Create a **Firestore** database, then deploy `firestore.rules` (client access is fully locked down — only your Netlify functions, via Admin SDK, touch this data).
3. Project settings → Your apps → Web: copy the config into `firebaseConfig` in `index.html`.
4. Project settings → **Service accounts** → Generate new private key. This downloads a JSON file — you'll paste its full contents into a Netlify env var (see below).
5. Authentication → Settings → Authorized domains: add your Netlify domain.

### 3. Netlify
1. Push this folder to a Git repo, then Netlify → Add site → Import from Git (no build command, publish dir `.`).
2. Site settings → Environment variables, add:
   - `ANTHROPIC_API_KEY`
   - `KROGER_CLIENT_ID`
   - `KROGER_CLIENT_SECRET`
   - `KROGER_REDIRECT_URI` — e.g. `https://your-site.netlify.app/.netlify/functions/kroger-auth-callback` (must exactly match what you set in Kroger's dashboard)
   - `APP_URL` — e.g. `https://your-site.netlify.app`
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — paste the full service-account JSON as a single-line string
3. Redeploy after adding env vars.

## How it works end to end
1. User signs in with Google (Firebase Auth) and pastes a recipe.
2. `parse-recipe` (Claude) extracts a clean ingredient list — nothing Kroger-related yet.
3. `match-products` looks up live Kroger prices for each ingredient near their ZIP. Nothing is cached beyond the single response.
4. User taps "Send to my Kroger cart." If they haven't connected Kroger yet, they're sent through `kroger-auth-start` → Kroger's consent screen → `kroger-auth-callback`, which stores only their refresh token in Firestore.
5. `cart-add` refreshes their access token and calls Kroger's real Cart API to add the items.

## Known gaps / what's not built yet
- No usage limits — add a per-user daily cap before sharing this publicly, since Claude and Kroger calls both cost money/rate-limit.
- No Stripe/subscription gating yet.
- Product matching picks the first search result — good enough to test, but will sometimes mismatch (e.g. "milk" → an odd size/brand). A "swap item" picker is the natural next feature.
- Kroger access tokens are short-lived and refresh tokens rotate on use — the code handles rotation, but token issues (revoked access, expired refresh token) will need a "reconnect Kroger" prompt in the UI eventually.
