const ORS_URL='https://api.openrouteservice.org/v2/matrix/driving-hgv';
const OSRM_URL='https://router.project-osrm.org/table/v1/driving';
const MAX_POINTS_PER_SIDE=250;
const ORS_MAX_ELEMENTS=3000;
const OSRM_MAX_COMBINED_COORDS=90;

function corsHeaders(origin){
  return {
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':origin,
    'Vary':'Origin',
  };
}

function allowedOrigin(event){
  const headers=event.headers||{};
  const rawOrigin=headers.origin||headers.Origin||'';
  let origin=rawOrigin;
  if(!origin){
    const referer=headers.referer||headers.Referer||'';
    try { origin=referer?new URL(referer).origin:''; } catch (_) {}
  }
  const allowed=new Set(
    [
      process.env.URL,
      process.env.DEPLOY_PRIME_URL,
      ...(process.env.ALLOWED_ORIGINS||'').split(','),
      'http://localhost:8888',
      'http://localhost:3000',
    ].map(v=>(v||'').trim().replace(/\/$/,'')).filter(Boolean)
  );
  return origin && allowed.has(origin.replace(/\/$/,'')) ? origin : null;
}

function validPoints(value){
  return Array.isArray(value) && value.length>0 && value.length<=MAX_POINTS_PER_SIDE &&
    value.every(p=>Array.isArray(p)&&p.length===2&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&
      p[0]>=-180&&p[0]<=180&&p[1]>=-90&&p[1]<=90);
}

async function orsMatrix(origins,destinations){
  if(!process.env.ORS_API_KEY) throw new Error('ORS_API_KEY is not configured');
  const distances=origins.map(()=>Array(destinations.length).fill(null));
  const durations=origins.map(()=>Array(destinations.length).fill(null));
  const originChunkSize=50;

  for(let oi=0;oi<origins.length;oi+=originChunkSize){
    const originChunk=origins.slice(oi,oi+originChunkSize);
    const destinationChunkSize=Math.max(1,Math.min(
      100-originChunk.length,
      Math.floor(ORS_MAX_ELEMENTS/originChunk.length)
    ));
    for(let di=0;di<destinations.length;di+=destinationChunkSize){
      const destinationChunk=destinations.slice(di,di+destinationChunkSize);
      const locations=[...originChunk,...destinationChunk];
      const response=await fetch(ORS_URL,{
        method:'POST',
        headers:{Authorization:process.env.ORS_API_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({
          locations,
          sources:originChunk.map((_,i)=>i),
          destinations:destinationChunk.map((_,i)=>originChunk.length+i),
          metrics:['distance','duration'],
          units:'mi',
        }),
      });
      if(!response.ok) throw new Error(`ORS returned ${response.status}: ${await response.text()}`);
      const data=await response.json();
      if(!data.distances||!data.durations) throw new Error('ORS returned an incomplete matrix');
      originChunk.forEach((_,localOrigin)=>{
        destinationChunk.forEach((__,localDestination)=>{
          distances[oi+localOrigin][di+localDestination]=data.distances[localOrigin][localDestination];
          durations[oi+localOrigin][di+localDestination]=data.durations[localOrigin][localDestination]/3600;
        });
      });
    }
  }
  return {distancesMiles:distances,durationsHours:durations};
}

async function osrmMatrix(origins,destinations){
  const distances=origins.map(()=>Array(destinations.length).fill(null));
  const durations=origins.map(()=>Array(destinations.length).fill(null));
  const originChunkSize=Math.min(45,OSRM_MAX_COMBINED_COORDS-1);

  for(let oi=0;oi<origins.length;oi+=originChunkSize){
    const originChunk=origins.slice(oi,oi+originChunkSize);
    const destinationChunkSize=Math.max(1,OSRM_MAX_COMBINED_COORDS-originChunk.length);
    for(let di=0;di<destinations.length;di+=destinationChunkSize){
      const destinationChunk=destinations.slice(di,di+destinationChunkSize);
      const points=[...originChunk,...destinationChunk];
      const coords=points.map(p=>`${p[0]},${p[1]}`).join(';');
      const sources=originChunk.map((_,i)=>i).join(';');
      const destinationIndexes=destinationChunk.map((_,i)=>originChunk.length+i).join(';');
      const url=`${OSRM_URL}/${coords}?sources=${sources}&destinations=${destinationIndexes}&annotations=distance,duration`;
      const response=await fetch(url);
      if(!response.ok) throw new Error(`OSRM returned ${response.status}`);
      const data=await response.json();
      if(data.code!=='Ok'||!data.distances||!data.durations) throw new Error(data.message||'Invalid OSRM matrix');
      originChunk.forEach((_,localOrigin)=>{
        destinationChunk.forEach((__,localDestination)=>{
          const globalOrigin=oi+localOrigin;
          const globalDestination=di+localDestination;
          distances[globalOrigin][globalDestination]=data.distances[localOrigin][localDestination]/1609.344;
          durations[globalOrigin][globalDestination]=data.durations[localOrigin][localDestination]/3600;
        });
      });
    }
  }
  return {distancesMiles:distances,durationsHours:durations};
}

exports.handler=async function(event){
  if(event.httpMethod==='OPTIONS'){
    const origin=allowedOrigin(event);
    return origin
      ? {statusCode:204,headers:{...corsHeaders(origin),'Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST, OPTIONS'},body:''}
      : {statusCode:403,body:'Forbidden'};
  }
  if(event.httpMethod!=='POST') return {statusCode:405,body:'Method not allowed'};
  const origin=allowedOrigin(event);
  if(!origin) return {statusCode:403,body:'Origin not allowed'};
  if((event.body||'').length>1_000_000) return {statusCode:413,body:'Request too large'};

  let payload;
  try { payload=JSON.parse(event.body||'{}'); }
  catch (_) { return {statusCode:400,body:'Invalid JSON'}; }
  const {origins,destinations}=payload;
  if(!validPoints(origins)||!validPoints(destinations)) {
    return {statusCode:400,body:`Origins and destinations must each contain 1-${MAX_POINTS_PER_SIDE} valid [longitude, latitude] points`};
  }

  try {
    const matrix=await orsMatrix(origins,destinations);
    return {statusCode:200,headers:corsHeaders(origin),body:JSON.stringify({provider:'OpenRouteService HGV',...matrix})};
  } catch (orsError) {
    try {
      const matrix=await osrmMatrix(origins,destinations);
      return {statusCode:200,headers:corsHeaders(origin),body:JSON.stringify({provider:'OSRM fallback',...matrix})};
    } catch (osrmError) {
      return {statusCode:502,headers:corsHeaders(origin),body:`Routing failed: ${orsError.message}; fallback failed: ${osrmError.message}`};
    }
  }
};
