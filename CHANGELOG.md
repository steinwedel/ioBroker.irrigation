# Changelog
## 0.2.16 (2026-07-21)
* (Gerhard Steinwedel) **ENHANCED**: "Add new plan" button is now disabled until a plan name is entered, and shows a confirmation dialog with the entered name before creating the plan — reduces the risk of creating a plan with an empty or unintended name. jsonConfig has no modal dialog type with a text input field (`confirm` only supports a static info/warning/error/none message without user input), so the "New plan name" text field next to the button remains the input mechanism; a full custom popup dialog would require building and maintaining a separate React admin component

## 0.2.15 (2026-07-21)
* (Gerhard Steinwedel) **ENHANCED**: "Valves in selected plan" is now a real table (valve number, name, "In plan" checkbox) instead of two separate multi-select boxes with Assign/Remove buttons — click "Load valves for selected plan" after changing the plan selection to populate the table, tick/untick valves, then click "Apply valve assignment" to save. "Add all valves to plan"/"Remove all valves from plan" quick actions remain and now also refresh the table immediately. jsonConfig's `table` type cannot load rows dynamically via `sendTo` (only static `native` arrays), so the table is populated via `useNative` from an explicit "Load" button rather than automatically on plan change

## 0.2.14 (2026-07-21)
* (Gerhard Steinwedel) **FIXED**: Admin UI "Selected plan" dropdown now correctly selects the newly created plan (or a valid remaining plan after deletion) instead of keeping the previous selection — `createPlan`/`deletePlan` now return `_editPlan` alongside `plans` in a single `useNative` response, since plans no longer live in native config (0.2.13) and `this.config2.plans` is updated synchronously before the response is sent, so combining both attributes in one response no longer risks the overlapping-refetch race that the two-step approach in 0.2.10/0.2.12 was working around

## 0.2.13 (2026-07-21)
* (Gerhard Steinwedel) **ENHANCED**: Plans now stored in dedicated `automation.plansData` state instead of native config — adding/editing/deleting plans from the admin UI no longer restarts the adapter. Previously, writing to native config always triggered a full restart, causing the "Selected plan" dropdown to become empty during the restart window. Legacy plans are automatically migrated to the new state on first load. `automation.plansList` maintained for backward compatibility

## 0.2.12 (2026-07-21)
* (Gerhard Steinwedel) **FIXED**: Admin UI 'Selected plan' dropdown no longer occasionally renders empty after creating a new plan — `createPlan` now returns only `plans` in its `useNative` response (not `newPlanName`), avoiding the sequential React render cycle that could trigger overlapping option-list refetches in the dropdown component. Trade-off: the 'New plan name' text field is no longer auto-cleared after adding a plan

## 0.2.11 (2026-07-21)
* (Gerhard Steinwedel) **FIXED**: Admin UI plan dropdown now updates immediately after creating/deleting plans within the same request cycle — `writeNativeAsync()` now syncs `this.config2` in-memory right after persisting to the database, so `listPlans` (triggered by `alsoDependsOn` refetch) sees the just-written data instead of the stale startup snapshot, eliminating the race condition where the dropdown appeared empty until the js-controller's async adapter restart completed
* (Gerhard Steinwedel) **FIXED**: Changelog preparation script no longer duplicates `## **WORK IN PROGRESS**` marker — `insertPlaceholderWithBody()` now detects and fills existing empty placeholders in place instead of always inserting a new marker line after `# Changelog`

## 0.2.10 (2026-07-21)
* (Gerhard Steinwedel) **FIXED**: Admin UI "Selected plan" dropdown now correctly shows plan names after creating/deleting plans instead of raw index numbers or becoming empty until page reload — added `alsoDependsOn: ["plans"]` to trigger option-list refetch, and changed `createPlan`/`deletePlan` handlers to return only `plans` (not `_editPlan`) in their `useNative` response to avoid two overlapping, unordered refetches that could leave the dropdown with zero options

## 0.2.9 (2026-07-20)
*(No user-visible changes — only restored the "WORK IN PROGRESS" placeholder in CHANGELOG.md)

## 0.2.8 (2026-07-20)
* (Gerhard Steinwedel) **FIXED**: Plans tab sendTo buttons now correctly send field values to backend — `jsonData` templates explicitly interpolate required fields via `${JSON.stringify(data.fieldName ?? fallback)}` instead of relying on `alsoDependsOn` (which only controls re-trigger timing, not payload inclusion), fixing "noName" errors when adding plans and undefined `_editPlan`/`availableValves`/`planValvesRefresh` in all valve-assignment commands
* (Gerhard Steinwedel) **FIXED**: Plan index validation now treats JSON `null` (sent when no plan is selected in dropdown) the same as `undefined` — added `readPlanIndex()` helper to prevent `null` from bypassing bounds checks due to JS numeric coercion
* (Gerhard Steinwedel) **ENHANCED**: Added missing error-code translations for plan management (`noName`, `noSelection`, `lastPlan`) in admin UI i18n files (English + German)

## 0.2.7 (2026-07-20)
* (Gerhard Steinwedel) **NEW**: AI-powered changelog generation script (`scripts/prepare-changelog.js`) now auto-generates "WORK IN PROGRESS" entry before each release by analyzing commits and diffs since the last version
* (Gerhard Steinwedel) **ENHANCED**: Plan management commands (`createPlan`/`deletePlan`) now compiled into build artifacts — version bumped to 0.2.6

## 0.2.6 (2026-07-20)
* (Gerhard Steinwedel) **ENHANCED**: Plans tab in admin UI no longer shows a separate plan-name table — the "Selected plan" dropdown is now the single control for managing plans, with new "Add new plan" and "Delete selected plan" actions (`createPlan`/`deletePlan` message handlers)
* (Gerhard Steinwedel) **FIXED**: ESLint now ignores the legacy `BW Automatik.js` javascript-adapter reference script (uses sandbox globals like `on`/`setState`/`schedule` that don't exist in this Node.js/TypeScript adapter) and a stray Prettier formatting issue in `config-defaults.ts` is fixed — `npm run lint` passes with 0 errors/warnings again

## 0.2.5 (2026-07-20)
* (Gerhard Steinwedel) **FIXED**: A Gardena valve started from the Gardena app or from ioBroker could be immediately closed again — `AutomationEngine.recoverAfterRestart()` unconditionally called `stop()` on every configured valve on every single adapter start/restart, regardless of whether an automation run was actually interrupted. It now only stops the specific valves recorded in `automation.batchZones`, and only when the persisted `automation.running` state confirms a plan-driven run was genuinely in progress when the process last shut down. Added regression tests
* (Gerhard Steinwedel) **FIXED**: `npm test` was silently skipping all tests in `src/main.test.ts` — the `src/**/*.test.ts` glob relies on shell globstar support, which `/bin/sh` (used by `npm run` on macOS) does not have, so only test files nested at least one directory deep ever ran. Mocha is now given the unexpanded, quoted glob directly so its own recursive matching is used regardless of the invoking shell
* (Gerhard Steinwedel) **FIXED**: Unit tests could non-deterministically fail to resolve local module imports under Node 23's default-enabled native TypeScript stripping racing with `ts-node/register`'s CommonJS loader; `--no-experimental-strip-types` is now set for `test:ts`

### 0.2.4 (2026-07-20)
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