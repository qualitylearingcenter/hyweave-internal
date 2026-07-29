# HyWeave deployment package

## What's in this zip
- `index.html` — the full app, place at your repo root
- `netlify.toml` — place at your repo root
- `netlify/functions/route-distance.js`
- `netlify/functions/hydrogen-stations.js`
- `netlify/functions/town-centers.js`
- `netlify/functions/geocode-addresses.js` (new — needed for the Real Estate Assets tab)

All four functions use the same `ORS_API_KEY` environment variable in Netlify — nothing new to configure for `geocode-addresses.js` if the other three already work.

## What's deliberately NOT in this zip
`notify-outage.js` — the copy on hand uses an older secret-header auth pattern that doesn't match what the current app actually sends (no header at all, matching the origin-restricted pattern the other functions use). Overwriting your currently-deployed version with it could break a working outage-notification flow. Leave your existing `notify-outage.js` in place untouched.

## To deploy
1. Replace `index.html` and `netlify.toml` at your repo root.
2. Replace the four listed files in `netlify/functions/` (don't touch `notify-outage.js`).
3. Confirm `ORS_API_KEY` is set in Netlify's environment variables.
4. After the site redeploys, test the outage-notify button once to confirm it's unaffected.
