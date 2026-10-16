const ORS_MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/driving-hgv';
const OSRM_TABLE_URL = 'https://router.project-osrm.org/table/v1/driving/';

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

  async function requestOrs(originChunk) {
    if (!process.env.ORS_API_KEY) throw new Error('ORS_API_KEY is not configured');
    const locations = originChunk.concat(destinations);
    const sourceIndexes = originChunk.map((_, i) => i);
    const destinationIndexes = destinations.map((_, i) => originChunk.length + i);
    const upstream = await fetch(ORS_MATRIX_URL, {
      method: 'POST',
      headers: { Authorization: process.env.ORS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations, sources: sourceIndexes, destinations: destinationIndexes, metrics: ['distance', 'duration'], units: 'm' }),
    });
    const text = await upstream.text();
    if (!upstream.ok) throw new Error(`OpenRouteService matrix request failed (${upstream.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  async function requestOsrm(originChunk) {
    const out = { distances: originChunk.map(() => []), durations: originChunk.map(() => []) };
    // Keep each OSRM table request below its common 100-coordinate limit. ORS can handle the
    // larger matrix directly; this split is only used when ORS is unavailable or errors.
    const maxDestinations = Math.max(1, 90 - originChunk.length);
    for (let destStart = 0; destStart < destinations.length; destStart += maxDestinations) {
      const destChunk = destinations.slice(destStart, destStart + maxDestinations);
      const locations = originChunk.concat(destChunk);
      const coords = locations.map(p => `${Number(p[0])},${Number(p[1])}`).join(';');
      const sources = originChunk.map((_, i) => i).join(';');
      const destinationIndexes = destChunk.map((_, i) => originChunk.length + i).join(';');
      const url = `${OSRM_TABLE_URL}${coords}?sources=${sources}&destinations=${destinationIndexes}&annotations=distance,duration`;
      const upstream = await fetch(url);
      const text = await upstream.text();
      if (!upstream.ok) throw new Error(`OSRM road matrix request failed (${upstream.status}): ${text.slice(0, 300)}`);
      const data = JSON.parse(text);
      if (data.code && data.code !== 'Ok') throw new Error(`OSRM road matrix request failed: ${data.message || data.code}`);
      (data.distances || []).forEach((row, i) => { out.distances[i].push(...(row || [])); });
      (data.durations || []).forEach((row, i) => { out.durations[i].push(...(row || [])); });
    }
    return out;
  }

  try {
    let provider = 'OpenRouteService driving-hgv';
    let useOsrm = !process.env.ORS_API_KEY;
    const chunks = [];
    for (let start = 0; start < origins.length; start += chunkSize) {
      chunks.push({ start, originChunk: origins.slice(start, start + chunkSize) });
    }
    // Run independent origin chunks concurrently. A large placement matrix should finish in
    // roughly one upstream round-trip instead of waiting 20–30 seconds per sequential chunk.
    const settled = await Promise.all(chunks.map(async ({start, originChunk}) => {
      let data;
      if (!useOsrm) {
        try { data = await requestOrs(originChunk); }
        catch (error) { useOsrm = true; provider = 'OSRM fallback'; data = await requestOsrm(originChunk); }
      } else data = await requestOsrm(originChunk);
      return { start, data };
    }));
    settled.forEach(({start, data})=>{
      (data.distances || []).forEach((row, i) => row.forEach((meters, j) => {
        if (Number.isFinite(Number(meters))) distancesMiles[start + i][j] = Number(meters) / 1609.344;
      }));
      (data.durations || []).forEach((row, i) => row.forEach((seconds, j) => {
        if (Number.isFinite(Number(seconds))) durationsHours[start + i][j] = Number(seconds) / 3600;
      }));
    });
    return response(200, { provider, distancesMiles, durationsHours });
  } catch (error) {
    return response(502, { error: error && error.message ? error.message : 'Road routing failed' });
  }
};
