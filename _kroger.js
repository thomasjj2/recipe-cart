// Shared helpers for talking to Kroger's OAuth2 + Products/Cart APIs.
// Docs: https://developer.kroger.com/documentation
const BASE = "https://api.kroger.com/v1";
const TOKEN_URL = `${BASE}/connect/oauth2/token`;
const AUTH_URL = `${BASE}/connect/oauth2/authorize`;

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
};

// App-level token (Client Credentials) — for read-only Products/Locations lookups.
// No user login involved; used to search products and prices.
let appToken = null; // { value, exp }
async function getAppToken() {
  if (appToken && appToken.exp > Date.now() + 5000) return appToken.value;
  const id = need("KROGER_CLIENT_ID");
  const secret = need("KROGER_CLIENT_SECRET");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: "grant_type=client_credentials&scope=product.compact",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || "Kroger app-token error");
  appToken = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return appToken.value;
}

// Build the URL to send a user to for cart.basic:write consent (Authorization Code flow).
function buildAuthorizeUrl(state) {
  const id = need("KROGER_CLIENT_ID");
  const redirect = need("KROGER_REDIRECT_URI");
  const params = new URLSearchParams({
    scope: "cart.basic:write",
    response_type: "code",
    client_id: id,
    redirect_uri: redirect,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Exchange an authorization code for a user access + refresh token.
async function exchangeCode(code) {
  const id = need("KROGER_CLIENT_ID");
  const secret = need("KROGER_CLIENT_SECRET");
  const redirect = need("KROGER_REDIRECT_URI");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || "Kroger code exchange error");
  return data; // { access_token, refresh_token, expires_in }
}

// Use a stored refresh token to get a fresh user access token.
async function refreshUserToken(refreshToken) {
  const id = need("KROGER_CLIENT_ID");
  const secret = need("KROGER_CLIENT_SECRET");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || "Kroger refresh error");
  return data; // { access_token, refresh_token, expires_in }
}

// Live product search — current price only, never stored beyond this response.
async function searchProducts(term, locationId) {
  const token = await getAppToken();
  const params = new URLSearchParams({ "filter.term": term, "filter.limit": "5" });
  if (locationId) params.set("filter.locationId", locationId);
  const r = await fetch(`${BASE}/products?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.errors?.[0]?.reason || "Kroger product search error");
  return data.data || [];
}

async function findNearestLocation(zip) {
  const token = await getAppToken();
  const params = new URLSearchParams({ "filter.zipCode.near": zip, "filter.limit": "1" });
  const r = await fetch(`${BASE}/locations?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.errors?.[0]?.reason || "Kroger location error");
  return data.data?.[0] || null;
}

// Add items to the logged-in user's real Kroger cart. Requires a user access token
// obtained via the Authorization Code flow (cart.basic:write).
async function addToCart(userAccessToken, items) {
  // items: [{ upc, quantity }]
  const r = await fetch(`${BASE}/cart/add`, {
    method: "PUT",
    headers: { authorization: `Bearer ${userAccessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ items: items.map((i) => ({ upc: i.upc, quantity: i.quantity || 1 })) }),
  });
  if (r.status !== 204) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.errors?.[0]?.reason || `Kroger cart add error (${r.status})`);
  }
  return true;
}

module.exports = { getAppToken, buildAuthorizeUrl, exchangeCode, refreshUserToken, searchProducts, findNearestLocation, addToCart };
