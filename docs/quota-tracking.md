# Quota tracking

Current status: no live provider quota adapter. Dashboard and MCP explicitly return unavailable and historical_without_snapshots. T3 source contains provider-specific usage-limit capability and websocket updates, but this implementation has no separately authorized websocket session and does not guess a REST endpoint or scrape login credentials.

Pure reset-window calculation is tested: choose the last valid sample before the matching explicit reset, reject out-of-window/invalid values, sort by source sample time, require boundary proximity and bounded sampling gaps to claim complete. Invalid/missing data remains NULL. This is a tested calculation primitive, not an operating sampler.

Pending integration: establish read-only supported provider-limit transport, fingerprint account identity, persist snapshots, use 600s normal/120s near-reset schedule, rate-limit probes, sample after turns/reconnect and at reset+1/+5 minutes, then expose complete/partial windows and projections. Historical unused capacity cannot be reconstructed unless retained snapshots are discovered. No forecast is shown as fact.
