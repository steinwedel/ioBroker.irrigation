# Changelog

## **WORK IN PROGRESS**
* (Gerhard Steinwedel) **FIXED**: Root cause of the adapter restart loop found and fixed — `extendForeignObjectAsync` deep-merges arrays by index instead of replacing them, so stale `valves`/`plans` array elements survived and kept re-triggering the "needs migration" check on every restart. All native config writes now use a full read-modify-write (`writeNativeAsync`) instead
* (Gerhard Steinwedel) **FIXED**: Real Husqvarna/Gardena API rate-limit violations found in production — `RateLimiter.acquire()` had a "fast path" with no mutual exclusion: concurrent calls from independent valve event handlers could all observe an empty window and the same stale `lastRequestTime`, then all get admitted within the same minimum-interval window instead of being spaced out. All `acquire()` calls are now funneled through a single serialized queue so no two callers can ever be granted a slot within `MIN_INTERVAL_MS` of each other, with regression tests covering the concurrency case

### 0.2.3 (2026-07-20)
* (Gerhard Steinwedel) **ENHANCED**: Plans now reference valve indexes directly (`valveIndexes: number[]`) — `groups` removed from valves. Plan assignment uses multi-select dropdown + bulk add/remove buttons in admin UI. Empty valve list = all valves (default "Alle" plan)
* (Gerhard Steinwedel) **FIXED**: Adapter restart loop resolved — migration now only checks for missing `valveNumber` instead of full config equality
* (Gerhard Steinwedel) **FIXED**: Release config now keeps `WORK IN PROGRESS` placeholder after each release (`addPlaceholder: true`)

### 0.2.2 (2026-07-20)
* (Gerhard Steinwedel) **FIXED**: Legacy zone objects (`zones.*`) are now cleaned up on adapter start
* (Gerhard Steinwedel) **FIXED**: Zones tab removed from admin UI
* (Gerhard Steinwedel) **FIXED**: Removed per-valve flow monitoring states (flowActual, flowExpected, calibrateFlow, waterCurrent, waterTotal) — flow is measured at pump level only

### 0.2.0 (2026-07-20)
* (Gerhard Steinwedel) **ENHANCED**: Zones removed — all zone properties (duration, enabled, flow rate, rain independence, etc.) moved directly to valves. Valves now operate independently with direct valve-index-based automation instead of zone-index-based
* (Gerhard Steinwedel) **NEW**: Valves now have `enabled` guard — disabled valves cannot be started/stopped
* (Gerhard Steinwedel) **NEW**: Valves now have `flowRateLpm` (l/min) for water consumption calculation

### 0.1.2 (2026-07-20)
* (Gerhard Steinwedel) Changelog moved from README.md to CHANGELOG.md

### 0.1.1 (2026-07-20)
* (Gerhard Steinwedel) **FIXED**: Rate limiter now enforces 1s minimum interval between requests to prevent parallel bursts reaching the Gardena API
* (Gerhard Steinwedel) **FIXED**: Gardena tick now also starts on external valve activations (activity_value from smartgarden), not only from adapter-initiated start/stop

### 0.1.0 (2026-07-20)
* (Gerhard Steinwedel) **NEW**: Smartgarden API rate limiter — enforces 9/10s + 699/7d + 1s min-interval to prevent 504 bursts (Gardena API)
* (Gerhard Steinwedel) **FIXED**: Gardena valves now count down every second (adapter-owned tick, synced with smartgarden's 60s push); auto-stop suppressed (device closes itself)