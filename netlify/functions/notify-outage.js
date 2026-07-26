function allowedOrigin(event){
  const headers=event.headers||{};
  const rawOrigin=headers.origin||headers.Origin||'';
  let origin=rawOrigin;
  if(!origin){
    const referer=headers.referer||headers.Referer||'';
    try { origin=referer?new URL(referer).origin:''; } catch (_) {}
  }
  const allowed=new Set([
    process.env.URL,
    process.env.DEPLOY_PRIME_URL,
    ...(process.env.ALLOWED_ORIGINS||'').split(','),
    'http://localhost:8888',
  ].map(v=>(v||'').trim().replace(/\/$/,'')).filter(Boolean));
  return origin && allowed.has(origin.replace(/\/$/,''));
}

exports.handler=async function(event){
  if(event.httpMethod!=='POST') return {statusCode:405,body:'Method not allowed'};
  if(!allowedOrigin(event)) return {statusCode:403,body:'Origin not allowed'};
  if(!process.env.RESEND_API_KEY||!process.env.OUTAGE_NOTIFY_TO||!process.env.OUTAGE_NOTIFY_FROM){
    return {statusCode:500,body:'Email is not configured. Set RESEND_API_KEY, OUTAGE_NOTIFY_TO, and OUTAGE_NOTIFY_FROM in Netlify.'};
  }
  if((event.body||'').length>100_000) return {statusCode:413,body:'Notification is too large'};

  let payload;
  try { payload=JSON.parse(event.body||'{}'); }
  catch (_) { return {statusCode:400,body:'Invalid JSON'}; }
  const subject=String(payload.subject||'HyWeave Outage Alert').replace(/[\r\n]+/g,' ').slice(0,200);
  const text=String(payload.text||'').slice(0,75_000);
  if(!text) return {statusCode:400,body:'Notification body is required'};

  try {
    const response=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        from:process.env.OUTAGE_NOTIFY_FROM,
        to:process.env.OUTAGE_NOTIFY_TO.split(',').map(v=>v.trim()).filter(Boolean),
        subject,
        text,
      }),
    });
    if(!response.ok) return {statusCode:502,body:`Email provider rejected the message: ${await response.text()}`};
    const data=await response.json();
    return {statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify({sent:true,id:data.id})};
  } catch (error) {
    return {statusCode:502,body:`Email delivery failed: ${error.message}`};
  }
};
