// netlify/functions/geocode-addresses.js
//
// Serverless proxy for OpenRouteService's structured Geocoding (Search) API -- turns street
// address / city / state / postal code into latitude/longitude, for the Real Estate Assets tab.
// Same key, same account as route-distance.js and town-centers.js -- no new service to sign up
// for if those are already configured.
//
// ---------------------------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------------------------
// Uses the SAME ORS_API_KEY environment variable as route-distance.js and town-centers.js --
// nothing new to configure if either of those is already set up. Put this file at
// netlify/functions/geocode-addresses.js alongside them.
//
// ---------------------------------------------------------------------------------------------
// LIMITS TO KNOW ABOUT
// ---------------------------------------------------------------------------------------------
// ORS's geocoding free tier is 1,000 requests/day, 100/minute -- geocoding is inherently
// one-address-per-request (unlike the Matrix API, there's no batch endpoint), so a few hundred
// addresses take real time and real quota. This function processes whatever batch the frontend
// sends in one Netlify invocation, running requests with limited concurrency (see MAX_CONCURRENT
// below) rather than all at once, to stay well under the per-minute cap. The frontend is
// responsible for splitting a large property list into reasonably-sized batches across multiple
// calls to this function and caching results, so nothing gets re-geocoded on every page load.
// ---------------------------------------------------------------------------------------------

const ORS_GEOCODE_URL = 'https://api.openrouteservice.org/geocode/search/structured';
const MAX_CONCURRENT = 5;

const response = (statusCode, body, contentType = 'text/plain; charset=utf-8') => ({
  statusCode,
  headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

function originAllowed(event) {
  const origin = event.headers.origin || '';
  if (!process.env.APP_ORIGIN || !origin) return true;
  try {
    return new URL(origin).origin === new URL(process.env.APP_ORIGIN).origin;
  } catch {
    return false;
  }
}

async function geocodeOne(item) {
  const url = new URL(ORS_GEOCODE_URL);
  url.searchParams.set('api_key', process.env.ORS_API_KEY);
  if (item.address) url.searchParams.set('address', item.address);
  if (item.city) url.searchParams.set('locality', item.city);
  if (item.state) url.searchParams.set('region', item.state);
  if (item.postalCode) url.searchParams.set('postalcode', item.postalCode);
  url.searchParams.set('boundary.country', 'US');
  url.searchParams.set('size', '1');

  const res = await fetch(url);
  const rawText = await res.text();
  if (!res.ok) {
    // Distinct from "searched fine, found nothing" -- a non-200 here (401/402/429, etc.) is
    // almost always quota exhaustion or a transient issue, not a bad address. Carrying the
    // actual status/body back lets the frontend tell "retry me" apart from "this address
    // genuinely doesn't resolve", instead of collapsing both into the same dead end.
    return { key: item.key, found: false, error: `HTTP ${res.status}: ${rawText.slice(0, 200)}` };
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return { key: item.key, found: false, error: `Non-JSON response: ${rawText.slice(0, 200)}` };
  }
  const feature = data.features && data.features[0];
  if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
    return { key: item.key, found: false, debug: { status: res.status, bodyPreview: rawText.slice(0, 200) } };
  }
  const [lon, lat] = feature.geometry.coordinates;
  const props = feature.properties || {};
  return {
    key: item.key, found: true, lat, lon,
    matchLabel: props.label || null,
    confidence: props.confidence != null ? props.confidence : null,
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return response(405, 'Method not allowed');
  if (!originAllowed(event)) return response(403, 'Origin not allowed');
  if (!process.env.ORS_API_KEY) {
    return response(500, 'Server not configured — set ORS_API_KEY in Netlify environment variables');
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return response(400, 'Invalid JSON body');
  }

  const items = payload.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 60) {
    return response(400, 'items must contain between 1 and 60 addresses (batch on the frontend for larger lists)');
  }
  if (items.some(it => !it || typeof it.key !== 'string')) {
    return response(400, 'Each item must have a string key');
  }

  try {
    const results = [];
    for (let i = 0; i < items.length; i += MAX_CONCURRENT) {
      const chunk = items.slice(i, i + MAX_CONCURRENT);
      const chunkResults = await Promise.all(chunk.map(it => geocodeOne(it).catch(err => ({ key: it.key, found: false, error: err.message }))));
      results.push(...chunkResults);
    }
    return response(200, { results }, 'application/json; charset=utf-8');
  } catch (err) {
    return response(502, `Geocoding request failed: ${err.message}`);
  }
};
