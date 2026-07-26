# HyWeave — Assumptions Underlying the Model Logic

This is a complete list of the simplifying assumptions baked into HyWeave's calculations,
organized by module. Nothing here is a "bug" — every one of these is a deliberate modeling
choice made to keep the tool fast, transparent, and explainable. But they matter for correctly
interpreting what the outputs do and don't guarantee.

## 1. Distance & Travel Time
- **Sourcing Plan, landed cost, the "direct from source" risk path, and the reported reach of
  every hub/HyCAS unit/asset** all use real road driving distance and time (via
  OpenRouteService) whenever the routing backend is configured and reachable — shown by a
  status badge wherever these figures appear. If the backend isn't configured, or a request
  fails, everything falls back to straight-line distance automatically, and the badge says so
  plainly rather than silently showing a wrong number as if it were real.
- For hub/HyCAS/Asset Placement specifically: the underlying **search** that decides how many
  hubs/units to place and where still runs on fast, free, straight-line distance — real routing
  can't tell you the driving distance to a point that isn't a real address yet, and the search
  evaluates many candidate configurations before settling on one. Real routing is applied
  *after* the search settles, to the final chosen locations only — routed from each location's
  nearest existing facility (a real, snappable address) rather than the raw mathematical
  centroid. Because real roads are typically longer than straight-line, a configuration the
  search believed had satisfied its target can occasionally turn out to narrowly miss it once
  real routing is applied — the tool re-checks and reports this honestly rather than keeping a
  stale "target met" result.
- Everywhere straight-line is still used as a fallback, real road distance will typically be
  longer — treat those figures as a lower bound.
- Travel time for real-routed pairs comes directly from the routing provider (reflecting actual
  road speeds); everywhere else it's still distance ÷ a single constant average transit speed
  parameter, with no traffic, road type, or time-of-day modeling.

## 2. Demand
- Each node's consumption is a **constant daily rate** — no time-of-day, day-of-week, or
  seasonal variation is modeled.
- "Safety days" is a deterministic buffer multiplier, not a statistical safety-stock calculation
  (no demand variability or service-level/confidence modeling).

## 3. Sourcing & Cost
- Sourcing assignment is a **global greedy least-landed-cost heuristic**: every possible
  node-source pair is sorted by landed cost and filled in that order, respecting source
  capacity. This is not a formally optimal linear/network-flow solve — a true optimizer could
  occasionally find a marginally cheaper global assignment, especially near capacity limits.
- **Trailers are always dispatched full.** Any volume on a lane rounds up to a whole number of
  trailer trips, and cost is calculated on that basis (trips × cost-per-mile × distance) — not a
  continuous per-unit transport rate.
- Landed cost = source unit cost + (cost-per-mile × distance ÷ trailer capacity). This doesn't
  reflect potential real-world price breaks at volume, multi-leg routing, or backhaul economics.
- Supply capacity constraints are enforced, but there's no modeling of production lead time,
  ramp-up constraints, or scheduling/queuing at a source.

## 4. Staging Hub / Trailer Placement
- Hub locations come from **weighted k-means clustering** in an Albers equal-area projection —
  a fast, explainable heuristic, not an exhaustively-searched or provably optimal facility
  location solve.
- A hub's proposed location is a **geometric centroid** of the demand it covers — it is not
  validated against real, available, permittable land. The "nearest existing facility" column
  is a scouting reference only.
- Hub count auto-search tries k = 1 up to a cap of **40**, stopping at the first count that
  satisfies both the distance and time target **as measured by fast straight-line distance**.
  It will not search past 40 hubs even for an extremely sprawling network — beyond that cap, it
  reports the best it found and flags that the search was capped.
- Once the search settles on a hub count and locations, the *reported* avg/max reach for those
  final hubs is upgraded to real road distance/time where the routing backend is available
  (routed from each hub's nearest existing facility, not the raw centroid — see Section 1). The
  search itself is never re-run against real routing, so it's possible for a configuration to
  show as having met its target during the search and then display as narrowly missing it once
  real numbers are applied — that's the more honest number surfacing, not a bug.
- Trailer count per hub = ceil(covered demand × average safety days ÷ trailer capacity) — a
  simple deterministic volume calculation with no variability/uncertainty buffer beyond what
  safety days already represents.
- The weighting used to prioritize hub placement (favoring high-risk, far-from-source,
  single-sourced, high-consumption nodes) is a heuristic scoring formula, not derived from a
  formal facility-location objective function.

## 5. Risk Tiering
- Risk tiers are **absolute thresholds**, not rankings relative to the rest of the network — a
  well-covered network can genuinely show zero High-risk nodes, and the tiers don't have to sum
  to any fixed proportion.
- A node's tier is decided by whichever is better: its assigned hub, or a direct trip from its
  primary supply source. This assumes a trailer **could**, in an emergency, be dispatched
  directly from a production source bypassing the hub network — which may not always be
  operationally realistic depending on how sources actually operate.
- The Medium-risk threshold is a fixed **75%** of the distance/time budget used — a convention
  built into the tool, not derived from a formal reliability model.
- An unmet-demand shortfall always forces High risk regardless of geographic proximity — a
  capacity shortfall is treated as strictly worse than a distance/time issue.

## 6. Mobile HyCAS Placement
- Same k-means clustering approach as staging hubs, sized independently against its own
  delivery-radius/response-time targets — and the same real-routing treatment for final reach
  described in Section 4 applies here too.
- **Assumes a compression failure affects only one node at a time.** A HyCAS unit's capacity is
  checked only against the single largest node it covers — the model does not protect against
  multiple simultaneous compression failures within the same coverage cluster.
- HyCAS units are treated as having no refill/downtime cycle the way trailers do — once placed,
  availability is assumed continuous, with no modeled maintenance windows or dispatch travel
  time to reach the site needing service.

## 7. Asset Placement (fixed inventory)
- Same clustering approach, but with a **user-supplied fixed count** rather than an auto-search
  for a minimum — it will not add or remove assets under any circumstance, and may fall short of
  your reference target if inventory is too small. Since there's no auto-search loop here, real
  routing (Section 4) is applied directly to whatever the clustering step produces.
- Individual assets are matched to locations via a **greedy pairing**: highest-need location
  gets the highest-capacity asset, and so on down the list. This is a transparent heuristic, not
  a formally optimal assignment — an unusual mix of asset capacities could occasionally be
  better matched a different way.
- Storage asset capacity checks assume **all covered nodes could draw on the asset
  simultaneously** (aggregate demand × safety days) — deliberately conservative.
- Compression asset capacity checks assume only the single largest covered node draws on it at
  a time, consistent with the Mobile HyCAS assumption above.

## 8. Scenario Planning (disruption simulation)
- Assumes a hub's **entire** staged trailer buffer is available to respond to whichever nodes
  are affected by the specific scenario being run — it does not model competing, simultaneous
  real-world demands on the same hub's buffer from unrelated events happening at the same time.
- The resupply-shuttle calculation assumes **exactly one dedicated trailer** running
  continuously between an affected node and its best remaining source — not multiple trailers
  working the same lane in parallel, which would sustain a higher rate.
- Does not model driver hours-of-service limits, loading dock scheduling, or real-world traffic
  during an actual emergency response.
- A node flagged as "directly disrupted" (its own site issue, not a supply-side outage) is
  assumed to still be reachable by a road-based trailer — this may not hold for every real
  failure mode (e.g. a washed-out access road).
- Alternate resupply excludes every currently-disrupted source for the full assumed outage
  duration — it does not model a partial or phased recovery mid-outage.

## 9. Pricing Model
- Buy and Lease figures come from independently-entered rate inputs. The tool does not compute
  real financing, amortization schedules, discount rates, tax treatment, or a formal total-cost-
  of-ownership comparison between the two.
- Only the **trailer count** is assumed to scale with the days-of-supply sensitivity tiers —
  HyCAS and node counts are held constant across every tier, since those are coverage/placement
  decisions in this model, not volume decisions.
- Volume discount brackets use **inclusive** min/max boundaries and are looked up per product
  type independently — a discount is never a function of combined spend across categories, only
  that category's own quantity in that specific pricing tier.
- The discount lookup takes the **first matching bracket** for a given product and quantity — an
  imported table with overlapping or out-of-order ranges could produce unexpected results.

## 10. General / Structural
- The whole network uses an **Albers Equal-Area Conic projection** tuned for the continental
  United States. Locations far outside North America would be geometrically distorted.
- The "nearest city" reference label comes from a fixed list of roughly 200 major U.S. cities —
  in sparsely populated areas, the named city may be 50+ miles from the actual computed point.
  Always check the latitude/longitude, not just the label.
- Everything runs **client-side, in a single browser session**. Nothing persists across a page
  reload unless explicitly exported (Save Scenario) and re-imported — there is no shared backend
  or database maintaining a canonical version of the network across users or sessions.
