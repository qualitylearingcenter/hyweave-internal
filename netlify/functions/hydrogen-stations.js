// Public hydrogen infrastructure proxy for NREL's Alternative Fuels Data Center.
// Keep NREL_API_KEY in Netlify environment variables; never place it in index.html.

const NREL_URL = 'https://developer.nrel.gov/api/alt-fuel-stations/v1.json';

const response = (statusCode, body, cache = 'no-store') => ({
  statusCode,
  headers: {
    'Content-Type': statusCode === 200 ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': cache,
  },
  body: statusCode === 200 ? JSON.stringify(body) : String(body),
});

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return response(405, 'Method not allowed');

  const origin = event.headers.origin || '';
  if (process.env.APP_ORIGIN && origin && origin !== process.env.APP_ORIGIN) {
    return response(403, 'Origin not allowed');
  }
  if (!process.env.NREL_API_KEY) {
    return response(500, 'Server not configured — set NREL_API_KEY in Netlify environment variables');
  }

  const query = new URLSearchParams({
    fuel_type: 'HY',
    country: 'US',
    status: 'all',
    access: 'all',
    limit: 'all',
  });

  try {
    const upstream = await fetch(`${NREL_URL}?${query}`, {
      headers: { 'X-Api-Key': process.env.NREL_API_KEY },
    });
    if (!upstream.ok) {
      const message = await upstream.text();
      return response(502, `NREL rejected the request: ${message}`);
    }

    const data = await upstream.json();
    const stations = (data.fuel_stations || []).map((station) => ({
      id: station.id,
      name: station.station_name,
      address: station.street_address,
      city: station.city,
      state: station.state,
      latitude: Number(station.latitude),
      longitude: Number(station.longitude),
      status: station.status_code,
      expectedDate: station.expected_date,
      access: station.access_code,
      retail: station.hy_is_retail,
      pressures: station.hy_pressures || [],
      standards: station.hy_standards || [],
      lastConfirmed: station.date_last_confirmed,
      statusUrl: station.hy_status_link,
    })).filter((station) => Number.isFinite(station.latitude) && Number.isFinite(station.longitude));

    return response(
      200,
      { source: 'NREL Alternative Fuels Data Center', fetchedAt: new Date().toISOString(), stations },
      'public, max-age=21600, s-maxage=21600'
    );
  } catch (error) {
    return response(500, `Hydrogen station request failed: ${error.message}`);
  }
};
