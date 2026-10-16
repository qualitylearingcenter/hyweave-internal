const ORS_MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/driving-hgv';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function response(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function finitePoint(point) {
  return Array.isArray(point) && point.length >= 2 &&
    Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]));
}

// ORS limits matrix elements. Chunk by origin while preserving the browser's expected
// rectangular rows, so a large network still gets one deterministic response.
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return response(405, { error: 'POST required' });
  if (!process.env.ORS_API_KEY) return response(503, { error: 'ORS_API_KEY is not configured' });

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return response(400, { error: 'Request body must be valid JSON' }); }
  const origins = Array.isArray(input.origins) ? input.origins.filter(finitePoint) : [];
  const destinations = Array.isArray(input.destinations) ? input.destinations.filter(finitePoint) : [];
  if (!origins.length || !destinations.length) return response(400, { error: 'origins and destinations are required' });
  if (origins.length !== (input.origins || []).length || destinations.length !== (input.destinations || []).length) {
    return response(400, { error: 'All coordinates must be finite [longitude, latitude] pairs' });
  }

  const distancesMiles = Array.from({ length: origins.length }, () => Array(destinations.length).fill(null));
  const durationsHours = Array.from({ length: origins.length }, () => Array(destinations.length).fill(null));
  const maxElements = 3500;
  const chunkSize = Math.max(1, Math.floor(maxElements / destinations.length));

  try {
    for (let start = 0; start < origins.length; start += chunkSize) {
      const originChunk = origins.slice(start, start + chunkSize);
      const locations = originChunk.concat(destinations);
      const sourceIndexes = originChunk.map((_, i) => i);
      const destinationIndexes = destinations.map((_, i) => originChunk.length + i);
      const upstream = await fetch(ORS_MATRIX_URL, {
        method: 'POST',
        headers: { Authorization: process.env.ORS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations, sources: sourceIndexes, destinations: destinationIndexes, metrics: ['distance', 'duration'], units: 'm' }),
      });
      const text = await upstream.text();
      if (!upstream.ok) return response(upstream.status, { error: `OpenRouteService matrix request failed: ${text.slice(0, 500)}` });
      const data = JSON.parse(text);
      (data.distances || []).forEach((row, i) => row.forEach((meters, j) => {
        if (Number.isFinite(Number(meters))) distancesMiles[start + i][j] = Number(meters) / 1609.344;
      }));
      (data.durations || []).forEach((row, i) => row.forEach((seconds, j) => {
        if (Number.isFinite(Number(seconds))) durationsHours[start + i][j] = Number(seconds) / 3600;
      }));
    }
    return response(200, { provider: 'OpenRouteService driving-hgv', distancesMiles, durationsHours });
  } catch (error) {
    return response(502, { error: error && error.message ? error.message : 'Road routing failed' });
  }
};
