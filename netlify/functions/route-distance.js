// netlify/functions/route-distance.js
//
// Serverless proxy for OpenRouteService's Matrix API -- returns REAL heavy-goods-vehicle distance and
// time between demand nodes and supply sources, replacing HyWeave's straight-line (haversine)
// distance for the Sourcing Plan and the "direct from source" risk path.
//
// ---------------------------------------------------------------------------------------------
// WHY THIS GOES THROUGH A BACKEND AT ALL (not called directly from the browser)
// ---------------------------------------------------------------------------------------------
// 1. Your ORS API key would otherwise sit in the public page source, where anyone could copy it
//    and burn through your free daily quota (2,500 requests/day) on your account.
// 2. This lets us cap and log usage server-side, and return a clear "quota likely exceeded"
//    message instead of a cryptic client-side failure.
//
// ---------------------------------------------------------------------------------------------
// SETUP (about 5 minutes -- genuinely free, no credit card required for the free tier)
// ---------------------------------------------------------------------------------------------
// 1. Sign up at https://openrouteservice.org/dev/#/signup and create an API key (called a
//    "token" in their dashboard).
// 2. In Netlify: Site settings -> Environment variables -> add:
//      ORS_API_KEY            = <your OpenRouteService API key>
//      APP_ORIGIN             = https://your-project.netlify.app (recommended)
// 3. Put this file at netlify/functions/route-distance.js (same site as notify-outage.js -- no
//    extra Netlify configuration needed beyond what you already have).
// 4. Redeploy. Your endpoint is:
//      https://<your-site>.netlify.app/.netlify/functions/route-distance
//
// ---------------------------------------------------------------------------------------------
// LIMITS TO KNOW ABOUT
// ---------------------------------------------------------------------------------------------
// - Free tier: 2,500 requests/day, 40,000/month, 40 concurrent. HyWeave's frontend is built to
//   make ONE matrix request per network change (not one per node-source pair), and to cache the
//   result, specifically to stay well inside this -- but if you have an unusually large network
//   or hit the cap anyway, this function returns a clear error and the app falls back to
//   straight-line distance automatically rather than breaking.
// - ORS's Matrix API caps a single request at 3,500 origin x destination combinations (e.g. 50
//   demand nodes x 50 supply sources = 2,500, comfortably under the cap). This function chunks
//   automatically if your network is larger than that.
// ---------------------------------------------------------------------------------------------

const ORS_MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/driving-hgv';
const OSRM_TABLE_URL = process.env.OSRM_TABLE_URL || 'https://router.project-osrm.org/table/v1/driving';
const MAX_ELEMENTS_PER_REQUEST = 3000; // stay a bit under ORS's 3,500 cap for safety margin

const text = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  body,
});

// Automatic road-network fallback when the ORS Matrix allowance is temporarily exhausted.
// OSRM's table service reports road distance in meters and duration in seconds. Requests are
// split so each contains at most 100 total coordinates, the public server's normal limit.
async function fetchOsrmMatrix(origins, destinations) {
  const distanceRows = origins.map(() => Array(destinations.length).fill(null));
  const durationRows = origins.map(() => Array(destinations.length).fill(null));
  const maxOriginsPerChunk = 50;

  for (let os = 0; os < origins.length; os += maxOriginsPerChunk) {
    const originChunk = origins.slice(os, os + maxOriginsPerChunk);
    const maxDestinationsPerChunk = Math.max(1, 100 - originChunk.length);
    for (let ds = 0; ds < destinations.length; ds += maxDestinationsPerChunk) {
      const destinationChunk = destinations.slice(ds, ds + maxDestinationsPerChunk);
      const coordinates = [...originChunk, ...destinationChunk];
      const coordinatePath = coordinates.map(pair => `${pair[0]},${pair[1]}`).join(';');
      const sources = originChunk.map((_, i) => i).join(';');
      const destinationIndexes = destinationChunk.map((_, i) => originChunk.length + i).join(';');
      const url = `${OSRM_TABLE_URL}/${coordinatePath}?annotations=distance,duration&sources=${sources}&destinations=${destinationIndexes}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'HyWeave/1.0' } });
      if (!res.ok) throw new Error(`OSRM fallback rejected the request (${res.status}): ${await res.text()}`);
      const data = await res.json();
      if (data.code !== 'Ok') throw new Error(`OSRM fallback failed: ${data.message || data.code}`);

      originChunk.forEach((_, oi) => {
        destinationChunk.forEach((_, di) => {
          const meters = data.distances && data.distances[oi] ? data.distances[oi][di] : null;
          const seconds = data.durations && data.durations[oi] ? data.durations[oi][di] : null;
          distanceRows[os + oi][ds + di] = meters == null ? null : meters / 1609.344;
          durationRows[os + oi][ds + di] = seconds == null ? null : seconds / 3600;
        });
      });
    }
  }
  return { distancesMiles: distanceRows, durationsHours: durationRows, provider: 'OSRM fallback' };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return text(405, 'Method not allowed');
  }

  // A browser-side "secret" is not secret: anyone can read it from the downloaded HTML.
  // Restrict browser calls to the configured application origin instead.
  const origin = event.headers.origin || '';
  if (process.env.APP_ORIGIN && origin) {
    try {
      if (new URL(origin).origin !== new URL(process.env.APP_ORIGIN).origin) {
        return text(403, 'Origin not allowed');
      }
    } catch {
      return text(500, 'APP_ORIGIN is not a valid URL');
    }
  }

  if (!process.env.ORS_API_KEY) {
    return text(500, 'Server not configured — set ORS_API_KEY in Netlify environment variables');
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return text(400, 'Invalid JSON body');
  }

  const { origins, destinations } = payload; // each: array of [lon, lat] pairs (ORS uses lon,lat order)
  if (!Array.isArray(origins) || !Array.isArray(destinations) || origins.length === 0 || destinations.length === 0) {
    return text(400, 'Missing or invalid origins/destinations arrays');
  }
  if (origins.length * destinations.length > 10000) {
    return text(400, 'Network too large for a single request (over 10,000 pairs) — contact support to discuss batching.');
  }

  // ORS takes ONE combined "locations" array plus index lists for sources/destinations, and caps
  // total origins x destinations per call -- chunk the destination list if needed to stay under it.
  const allLocations = [...origins, ...destinations];
  const originIdx = origins.map((_, i) => i);
  const destCountPerChunk = Math.max(1, Math.floor(MAX_ELEMENTS_PER_REQUEST / origins.length));

  const distanceRows = origins.map(() => []);
  const durationRows = origins.map(() => []);

  try {
    for (let start = 0; start < destinations.length; start += destCountPerChunk) {
      const chunk = destinations.slice(start, start + destCountPerChunk);
      const chunkLocations = [...origins, ...chunk];
      const chunkDestIdx = chunk.map((_, i) => origins.length + i);

      const resp = await fetch(ORS_MATRIX_URL, {
        method: 'POST',
        headers: {
          'Authorization': process.env.ORS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          locations: chunkLocations,
          sources: originIdx,
          destinations: chunkDestIdx,
          metrics: ['distance', 'duration'],
          units: 'mi',
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        if (resp.status === 403 || resp.status === 429 || resp.status >= 500) {
          try {
            const fallback = await fetchOsrmMatrix(origins, destinations);
            return {
              statusCode: 200,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'public, max-age=3600',
              },
              body: JSON.stringify(fallback),
            };
          } catch (fallbackError) {
            return text(502, `OpenRouteService unavailable (${errText}); ${fallbackError.message}`);
          }
        }
        return text(502, `Routing provider rejected the request: ${errText}`);
      }

      const data = await resp.json();
      // data.distances / data.durations are [origin][destination] matrices for this chunk
      for (let i = 0; i < origins.length; i++) {
        distanceRows[i].push(...(data.distances[i] || []));
        durationRows[i].push(...(data.durations[i] || []));
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
      body: JSON.stringify({
        distancesMiles: distanceRows,
        durationsHours: durationRows.map(row => row.map(s => s / 3600)),
        provider: 'OpenRouteService HGV',
      }),
    };
  } catch (err) {
    return text(500, `Routing request failed: ${err.message}`);
  }
};
