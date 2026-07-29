const ORS_REVERSE_URL = 'https://api.openrouteservice.org/geocode/reverse';
const MAX_POINTS = 40;

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

async function reverseTown(point) {
  const url = new URL(ORS_REVERSE_URL);
  url.searchParams.set('api_key', process.env.ORS_API_KEY);
  url.searchParams.set('point.lon', String(point.lon));
  url.searchParams.set('point.lat', String(point.lat));
  url.searchParams.set('size', '1');
  url.searchParams.set('layers', 'locality,localadmin');

  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Town lookup failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
    return { key: point.key, found: false };
  }

  const p = feature.properties || {};
  const [lon, lat] = feature.geometry.coordinates;
  return {
    key: point.key,
    found: true,
    lat,
    lon,
    name: p.locality || p.localadmin || p.name || p.label || 'Nearest town',
    state: p.region_a || p.region || '',
    country: p.country_a || p.country || '',
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
    return response(200, { towns }, 'application/json; charset=utf-8');
  } catch (err) {
    return response(502, err.message);
  }
};
