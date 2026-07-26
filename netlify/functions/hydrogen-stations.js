const STATIONS_URL='https://developer.nlr.gov/api/alt-fuel-stations/v1.json';

function allowedOrigin(event){
  const headers=event.headers||{};
  const raw=headers.origin||headers.Origin||'';
  let origin=raw;
  if(!origin){
    try { origin=new URL(headers.referer||headers.Referer||'').origin; } catch (_) {}
  }
  const allowed=new Set([
    process.env.URL,process.env.DEPLOY_PRIME_URL,
    ...(process.env.ALLOWED_ORIGINS||'').split(','),
    'http://localhost:8888',
  ].map(v=>(v||'').trim().replace(/\/$/,'')).filter(Boolean));
  return origin&&allowed.has(origin.replace(/\/$/,''));
}

exports.handler=async function(event) {
  if (event.httpMethod!=='GET') return {statusCode:405,body:'Method not allowed'};
  if (!allowedOrigin(event)) return {statusCode:403,body:'Origin not allowed'};
  try {
    const url=new URL(STATIONS_URL);
    url.searchParams.set('api_key',process.env.NLR_API_KEY||process.env.NREL_API_KEY||'DEMO_KEY');
    url.searchParams.set('fuel_type','HY');
    url.searchParams.set('country','US');
    url.searchParams.set('limit','all');
    const response=await fetch(url);
    if (!response.ok) return {statusCode:502,body:`NLR station API failed (${response.status})`};
    const data=await response.json();
    const stations=(data.fuel_stations||[]).map(s=>({
      id:s.id,
      name:s.station_name,
      address:s.street_address,
      city:s.city,
      state:s.state,
      latitude:Number(s.latitude),
      longitude:Number(s.longitude),
      status:s.status_code,
      access:s.access_code,
      pressures:Array.isArray(s.hydrogen_pressures)?s.hydrogen_pressures:
        String(s.hydrogen_pressures||'').split(',').map(x=>x.trim()).filter(Boolean),
    })).filter(s=>Number.isFinite(s.latitude)&&Number.isFinite(s.longitude));
    return {
      statusCode:200,
      headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=3600'},
      body:JSON.stringify({stations}),
    };
  } catch (error) {
    return {statusCode:502,body:`Hydrogen-station lookup failed: ${error.message}`};
  }
};
