const ORS_REVERSE_URL = 'https://api.openrouteservice.org/geocode/reverse';
const ORS_STRUCTURED_URL = 'https://api.openrouteservice.org/geocode/search/structured';
const US_PLACES = require('./us-places.json');
const MAX_POINTS = 40;
const BACKEND_VERSION = 'town-centers-v2-diagnostics';
const SEARCH_RADII_KM = [5, 25, 100];
const TOWN_LAYERS = 'locality,localadmin';

function toRadians(value) {
  return value * Math.PI / 180;
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isSupportedUSPoint(lat, lon) {
  const continental = lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66;
  const alaska = lat >= 51 && lat <= 72 && lon >= -180 && lon <= -129;
  const hawaii = lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154;
  const puertoRico = lat >= 17.5 && lat <= 18.6 && lon >= -67.5 && lon <= -65;
  return continental || alaska || hawaii || puertoRico;
}

function nearestCensusPlace(point) {
  let best = null;
  let bestDistance = Infinity;
  for (const place of US_PLACES) {
    const distance = distanceMiles(point.lat, point.lon, place[2], place[3]);
    if (distance < bestDistance) {
      best = place;
      bestDistance = distance;
    }
  }
  if (!best) return null;
  return {
    key: point.key,
    found: true,
    lat: best[2],
    lon: best[3],
    name: best[0],
    state: best[1],
    country: 'USA',
    debug: {
      status: 200,
      radiusKm: Number((bestDistance * 1.609344).toFixed(2)),
      layers: '2024 U.S. Census places',
      method: 'nearest-census-place',
    },
  };
}

const response = (statusCode, body, contentType = 'text/plain; charset=utf-8') => ({
  statusCode,
  headers: {
    'Content-Type': contentType,
    // POST responses depend on the requested coordinates. Do not let a CDN or browser reuse a
    // prior batch response after the gazetteer or lookup logic changes.
    'Cache-Control': 'no-store',
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

async function lookupEnclosingPlace(point) {
  const url = new URL(ORS_REVERSE_URL);
  url.searchParams.set('api_key', process.env.ORS_API_KEY);
  url.searchParams.set('point.lon', String(point.lon));
  url.searchParams.set('point.lat', String(point.lat));
  url.searchParams.set('size', '1');
  url.searchParams.set('boundary.circle.radius', '10');

  const res = await fetch(url);
  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, bodyPreview: raw.slice(0, 500) };
  }
  try {
    const data = JSON.parse(raw);
    return { ok: true, status: res.status, feature: data.features && data.features[0] };
  } catch {
    return { ok: false, status: res.status, bodyPreview: raw.slice(0, 500) };
  }
}

async function lookupPlaceCenter(properties) {
  const locality = properties.locality || properties.localadmin;
  if (!locality) return { ok: true, feature: null, status: 200 };

  const url = new URL(ORS_STRUCTURED_URL);
  url.searchParams.set('api_key', process.env.ORS_API_KEY);
  url.searchParams.set('locality', locality);
  if (properties.region) url.searchParams.set('region', properties.region);
  if (properties.country_a) url.searchParams.set('boundary.country', properties.country_a);
  url.searchParams.set('size', '1');
  url.searchParams.set('layers', TOWN_LAYERS);

  const res = await fetch(url);
  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, bodyPreview: raw.slice(0, 500) };
  }
  try {
    const data = JSON.parse(raw);
    return { ok: true, status: res.status, feature: data.features && data.features[0] };
  } catch {
    return { ok: false, status: res.status, bodyPreview: raw.slice(0, 500) };
  }
}

function townResult(point, feature, debug) {
  const p = feature.properties || {};
  const [lon, lat] = feature.geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    key: point.key,
    found: true,
    lat,
    lon,
    name: p.locality || p.localadmin || p.name || p.label || 'Nearest town',
    state: p.region_a || p.region || '',
    country: p.country_a || p.country || '',
    debug,
  };
}

async function reverseTown(point) {
  if (isSupportedUSPoint(point.lat, point.lon)) {
    return nearestCensusPlace(point);
  }
  if (!process.env.ORS_API_KEY) {
    return {
      key: point.key,
      found: false,
      error: true,
      debug: {
        status: 500,
        radiusKm: 0,
        layers: '',
        method: 'outside-us-without-ors-key',
        bodyPreview: 'ORS_API_KEY is required for points outside the U.S. Census gazetteer coverage',
      },
    };
  }

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

    const result = townResult(point, attempt.feature, {
      status: attempt.status,
      radiusKm: attempt.radiusKm,
      layers: attempt.layers,
      method: 'reverse-town-layer',
    });
    if (result) return result;
  }

  // A coordinate outside a mapped municipal polygon can produce no locality-layer result even
  // when a town is close by. Resolve a nearby address without a layer restriction, take the
  // locality from that address, then forward-geocode that locality to its actual center.
  const enclosing = await lookupEnclosingPlace(point);
  if (!enclosing.ok) {
    return {
      key: point.key,
      found: false,
      error: true,
      debug: {
        status: enclosing.status,
        radiusKm: 10,
        layers: 'unfiltered',
        method: 'reverse-address',
        bodyPreview: enclosing.bodyPreview,
      },
    };
  }
  if (enclosing.feature) {
    const center = await lookupPlaceCenter(enclosing.feature.properties || {});
    if (!center.ok) {
      return {
        key: point.key,
        found: false,
        error: true,
        debug: {
          status: center.status,
          radiusKm: 100,
          layers: TOWN_LAYERS,
          method: 'structured-locality',
          bodyPreview: center.bodyPreview,
        },
      };
    }
    if (center.feature && center.feature.geometry &&
        Array.isArray(center.feature.geometry.coordinates)) {
      const result = townResult(point, center.feature, {
        status: center.status,
        radiusKm: 100,
        layers: TOWN_LAYERS,
        method: 'reverse-address-then-structured-locality',
      });
      if (result) return result;
    }
  }

  const debug = lastAttempt ? {
    status: lastAttempt.status,
    radiusKm: lastAttempt.radiusKm,
    layers: lastAttempt.layers,
    method: 'reverse-town-layer',
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
