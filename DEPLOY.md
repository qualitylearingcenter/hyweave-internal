# HyWeave Netlify deployment

## 1. Create API keys

- OpenRouteService: create a token at https://openrouteservice.org/dev/#/signup
- NREL Developer Network: create a key at https://developer.nrel.gov/signup/

## 2. Add Netlify environment variables

Open **Project configuration → Environment variables** and add:

| Variable | Value |
|---|---|
| `ORS_API_KEY` | Your OpenRouteService token |
| `NREL_API_KEY` | Your NREL developer key |
| `APP_ORIGIN` | Your production origin, such as `https://h2daizzo.netlify.app` |

Do not add `ROUTE_FUNCTION_SECRET`. The previous value was embedded in public HTML and therefore could not provide authentication.

## 3. Deploy

Upload this entire `hyweave-netlify` folder to a new Netlify project, or commit the folder contents to the root of the repository connected to Netlify.

The deployed file browser should show:

```text
index.html
netlify.toml
netlify/
  functions/
    route-distance.js
    hydrogen-stations.js
    town-centers.js
```

After adding or changing environment variables, trigger a new production deploy.

## 4. Verify

1. Open HyWeave and select **Load Sample Data**.
2. Open **Optimization Results**.
3. The routing badge should change from “Fetching real road distances…” to “Real road”.
4. The map toolbar should report the number of public H₂ stations loaded.
5. Hover a teal station marker to see the NREL record.

Public NREL stations are shown for context only. They are not treated as commercial supply sources unless a user explicitly adds capacity, availability, and cost assumptions.
