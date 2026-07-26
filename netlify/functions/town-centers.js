const ORS_REVERSE_URL = 'https://api.openrouteservice.org/geocode/reverse';

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return {statusCode:405, body:'Method not allowed'};
  if (!process.env.ORS_API_KEY) return {statusCode:500, body:'Set ORS_API_KEY in Netlify environment variables'};

  let body;
  try { body=JSON.parse(event.body||'{}'); }
  catch (_) { return {statusCode:400, body:'Invalid JSON'}; }
  if (!Array.isArray(body.points) || body.points.length>50) {
    return {statusCode:400, body:'points must be an array of 50 or fewer coordinates'};
  }

  try {
    const towns=[];
    for (const p of body.points) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
        towns.push({key:p.key,found:false});
        continue;
      }
      const url=new URL(ORS_REVERSE_URL);
      url.searchParams.set('api_key',process.env.ORS_API_KEY);
      url.searchParams.set('point.lat',String(p.lat));
      url.searchParams.set('point.lon',String(p.lon));
      url.searchParams.set('size','10');
      url.searchParams.set('layers','locality,county');
      const response=await fetch(url);
      if (!response.ok) {
        towns.push({key:p.key,found:false});
        continue;
      }
      const data=await response.json();
      const feature=(data.features||[]).find(f=>{
        const props=f.properties||{};
        return props.locality || props.localadmin || props.county || props.name;
      });
      if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
        towns.push({key:p.key,found:false});
        continue;
      }
      const props=feature.properties||{};
      towns.push({
        key:p.key,
        found:true,
        lon:Number(feature.geometry.coordinates[0]),
        lat:Number(feature.geometry.coordinates[1]),
        name:props.locality||props.localadmin||props.name||props.county||'Nearest town',
        state:props.region_a||props.region||'',
      });
    }
    return {statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify({towns})};
  } catch (error) {
    return {statusCode:502,body:`Town-center lookup failed: ${error.message}`};
  }
};
