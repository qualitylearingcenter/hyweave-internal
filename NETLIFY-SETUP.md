# HyWeave Netlify setup

Deploy this folder with `index.html` at the publish root.

## Required environment variables

- `ORS_API_KEY` — OpenRouteService API key for truck routing and town-center lookup.
- `RESEND_API_KEY` — Resend API key for automatic outage email.
- `OUTAGE_NOTIFY_TO` — fixed recipient address. Multiple addresses may be comma-separated.
- `OUTAGE_NOTIFY_FROM` — verified Resend sender, for example `HyWeave <alerts@yourdomain.com>`.

## Optional environment variables

- `NLR_API_KEY` — National Laboratory of the Rockies developer key. The function uses
  `DEMO_KEY` when this is not set.
- `ALLOWED_ORIGINS` — comma-separated additional authorized origins, without paths.
  Netlify's production `URL` and deploy-preview URL are accepted automatically.

After changing environment variables, trigger a new Netlify production deployment.

The routing function validates the caller's origin, limits request size and coordinate counts,
chunks both ORS and OSRM matrices, and labels OSRM results as a non-truck-verified fallback.
Outage recipients are fixed server-side; the browser cannot turn the email function into an
arbitrary-address relay.
