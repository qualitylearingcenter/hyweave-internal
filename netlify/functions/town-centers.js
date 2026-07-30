const ORS_REVERSE_URL = 'https://api.openrouteservice.org/geocode/reverse';
const MAX_POINTS = 40;
const BACKEND_VERSION = 'town-centers-v2-diagnostics';
const SEARCH_RADII_KM = [5, 25, 100];
const TOWN_LAYERS = 'locality,localadmin';

const response = (statusCode, body, contentType = 'text/plain; charset=utf-8') => ({
  statusCode,
  headers: {
    'Content-Type': contentType,
    'Cache-Control': statusCode === 200 ? 'public, max-age=86400' : 'no-store',
  },
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

async function lookupTown(point, radiusKm) {
  const url = new URL(ORS_REVERSE_URL);
  url.searchParams.set('api_key', process.env.ORS_API_KEY);
  url.searchParams.set('point.lon', String(point.lon));
  url.searchParams.set('point.lat', String(point.lat));
  url.searchParams.set('size', '1');
  url.searchParams.set('layers', TOWN_LAYERS);
  url.searchParams.set('boundary.circle.radius', String(radiusKm));

  const res = await fetch(url);
  const raw = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      radiusKm,
      layers: TOWN_LAYERS,
      bodyPreview: raw.slice(0, 500),
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      status: res.status,
      radiusKm,
      layers: TOWN_LAYERS,
      bodyPreview: raw.slice(0, 500),
    };
  }

  const feature = data.features && data.features[0];
  if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
    return {
      ok: true,
      feature: null,
      status: res.status,
      radiusKm,
      layers: TOWN_LAYERS,
      bodyPreview: raw.slice(0, 500),
    };
  }

  return { ok: true, feature, status: res.status, radiusKm, layers: TOWN_LAYERS };
}

async function reverseTown(point) {
  let lastAttempt = null;
  for (const radiusKm of SEARCH_RADII_KM) {
    let attempt;
    try {
      attempt = await lookupTown(point, radiusKm);
    } catch (err) {
      return {
        key: point.key,
        found: false,
        error: true,
        debug: {
          status: 0,
          radiusKm,
          layers: TOWN_LAYERS,
          bodyPreview: err && err.message ? err.message : String(err),
        },
      };
    }
    lastAttempt = attempt;

    // HTTP failures are transient. Report them per point so one failure does not discard every
    // other successful lookup in the same batch.
    if (!attempt.ok) {
      return {
        key: point.key,
        found: false,
        error: true,
        debug: {
          status: attempt.status,
          radiusKm: attempt.radiusKm,
          layers: attempt.layers,
          bodyPreview: attempt.bodyPreview,
        },
      };
    }
    if (!attempt.feature) continue;

    const feature = attempt.feature;
    const p = feature.properties || {};
    const [lon, lat] = feature.geometry.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    return {
      key: point.key,
      found: true,
      lat,
      lon,
      name: p.locality || p.localadmin || p.name || p.label || 'Nearest town',
      state: p.region_a || p.region || '',
      country: p.country_a || p.country || '',
      debug: {
        status: attempt.status,
        radiusKm: attempt.radiusKm,
        layers: attempt.layers,
      },
    };
  }

  const debug = lastAttempt ? {
    status: lastAttempt.status,
    radiusKm: lastAttempt.radiusKm,
    layers: lastAttempt.layers,
    bodyPreview: lastAttempt.bodyPreview,
  } : {
    status: 0,
    radiusKm: SEARCH_RADII_KM[SEARCH_RADII_KM.length - 1],
    layers: TOWN_LAYERS,
    bodyPreview: 'No lookup attempt completed',
  };
  return { key: point.key, found: false, debug };
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

  const points = payload.points;
  if (!Array.isArray(points) || points.length === 0 || points.length > MAX_POINTS) {
    return response(400, `points must contain between 1 and ${MAX_POINTS} locations`);
  }
  if (points.some(p => !p || typeof p.key !== 'string' || !Number.isFinite(p.lat) ||
    !Number.isFinite(p.lon) || p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180)) {
    return response(400, 'Each point must have a key and valid numeric lat/lon');
  }

  try {
    // Small batches avoid sending a burst of geocoder requests while remaining fast enough for
    // a nationwide placement plan.
    const towns = [];
    for (let start = 0; start < points.length; start += 5) {
      towns.push(...await Promise.all(points.slice(start, start + 5).map(reverseTown)));
    }
    return response(200, { backendVersion: BACKEND_VERSION, towns }, 'application/json; charset=utf-8');
  } catch (err) {
    return response(502, err.message);
  }
};
