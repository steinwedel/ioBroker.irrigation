# Changelog
## 0.3.17 (2026-07-26)
* (Gerhard Steinwedel) **ENHANCED**: Added an optional object-tree selectable soil-moisture sensor per valve; its moisture threshold is enabled only when that valve has a sensor assignment

## 0.3.16 (2026-07-26)
* (Gerhard Steinwedel) **FIXED**: Disable a valve's flow-rate editor until the global flow monitor is enabled and a flow-sensor state ID is configured

## 0.3.15 (2026-07-26)
* (Gerhard Steinwedel) **FIXED**: Starting a valve through its adapter `state` now runs it for the configured manual duration and stopping that state ends the manual run cleanly

## 0.3.14 (2026-07-26)
* (Gerhard Steinwedel) **ENHANCED**: Added a dedicated valve detail editor that keeps the main valve table compact while allowing all valve settings to be edited before saving the adapter configuration

## 0.3.13 (2026-07-26)
* (Gerhard Steinwedel) **FIXED**: Reverted the broken "Valve details (expert)" accordion (0.3.12) that showed no fields at all, because JSONConfig's `accordion` type does not support pointing at a different attribute via `attr` — it always binds to its own item key. Expert-only valve fields (enabled, flow rate, rain independence, moisture threshold, manual duration, Rainbird all-off state) are shown as columns in the main valves table again, hidden unless expert mode is enabled

## 0.3.12 (2026-07-26)
* (Gerhard Steinwedel) **ENHANCED**: Valves table now shows only the core columns (number, name, type, duration, state id) with sorting/filtering on name, type and state id, plus a compact/card layout on small screens; expert-only fields (enabled, flow rate, rain independence, moisture threshold, manual duration, Rainbird all-off state) are now edited per valve in a collapsible "Valve details (expert)" accordion instead of cramming extra columns into the main table

## 0.3.11 (2026-07-26)
* (Gerhard Steinwedel) **FIXED**: Pause/resume now tracks four independent blocker flags (rain, wind, legal restriction, manual) instead of a single `pauseReason` enum, so overlapping blockers (e.g. rain + legal restriction) are handled correctly and resume only happens when *all* blockers have cleared
* (Gerhard Steinwedel) **FIXED**: Valve `endsAt` timestamps now refresh on every resume to reflect actual remaining time — previously each pause/resume cycle silently shortened watering duration because `tick()` compared against the original (stale) end time
* (Gerhard Steinwedel) **ENHANCED**: DWD restriction date parsing now accepts zero-padded dates (e.g. "01.06") and validates date/time ranges with meaningful error messages; fetch timeout added (15s)
* (Gerhard Steinwedel) **ENHANCED**: SensorManager loads current sensor values immediately after (re)start instead of waiting for first push; tracks timestamp per sensor and validates incoming values more strictly
* (Gerhard Steinwedel) **ENHANCED**: WeatherApi and WindMonitor add fetch timeout (15s), API key masking in logs, and immediate value loading after (re)start; poll interval and hysteresis minutes validated for finiteness
* (Gerhard Steinwedel) **FIXED**: FlowMonitor now aborts calibration cleanly if configuration changes mid-calibration; improved error handling in `finishCalibration()`
* (Gerhard Steinwedel) **ENHANCED**: NotificationManager sends Pushover and Telegram notifications in parallel with `Promise.allSettled()` instead of sequentially, so one missing channel cannot block the other
* (Gerhard Steinwedel) **FIXED**: WaterConsumptionTracker serializes all state writes with `writeChain` to prevent race conditions when multiple valves change simultaneously
* (Gerhard Steinwedel) **FIXED**: ValveController Rainbird stop command error handling corrected — now sets `running=true` and logs error instead of `running=false` when stop command cannot be verified
* (Gerhard Steinwedel) **FIXED**: `parseDuration` now explicitly handles null/empty strings and negative values correctly, clamping to 1s minimum instead of falling back to default

## 0.3.10 (2026-07-25)
* (Gerhard Steinwedel) **FIXED**: Added null-safety checks to `onForeignStateChange()` calls for optional manager instances (`sensorManager`, `windMonitor`, `dwd`, `scheduler`, `flowMonitor`) to prevent NullPointerExceptions if these instances are not initialized

## 0.3.9 (2026-07-25)
* (Gerhard Steinwedel) **FIXED**: `FlowMonitor.getExpectedFlow()`/calibration built the `flowExpected` object id from a valve's raw array index instead of its stable `id`, so both could read/write the wrong valve's calibration data once valves were reordered/deleted/re-added in the admin Valves table
* (Gerhard Steinwedel) **FIXED**: Flow calibration now explicitly runs the valve for the calibration window's own fixed duration instead of the valve's configured watering `duration` - previously a short configured duration could let the valve auto-stop mid-calibration while sampling continued (now at zero flow) for the rest of the window, skewing the calibrated rate down
* (Gerhard Steinwedel) **FIXED**: Flow monitoring now correctly models the actual supported hardware - a single shared flow sensor directly behind the water source (e.g. the pump), never one sensor per valve. Removed the non-functional per-valve `flowSensorId` field; added a global `flowMonitor.enabled`/`flowMonitor.sensorId` setting. Leak detection now checks the shared sensor against whichever valves are actually running (instead of per-valve tracking that could clear a genuine leak indicator whenever an unrelated valve started), and deviation detection compares the shared reading against the *sum* of expected flow of all valves running in the same parallel batch
* (Gerhard Steinwedel) **NEW**: Per-valve flow calibration is now actually wired up (`valves.valve_NNN.calibrateFlow` button) - it previously existed in code but was never reachable from any state or UI. Calibration opens exactly one valve at a time against the shared sensor and is rejected while another valve is already running or no sensor is configured
* (Gerhard Steinwedel) **FIXED**: The `manualStart` command handler resolved a valve's state-object numeric suffix directly as an array index instead of via its stable `id`, which could target the wrong valve after valves were reordered/deleted/re-added in the admin Valves table; the new `calibrateFlow` handler uses the same corrected lookup
* (Gerhard Steinwedel) **ENHANCED**: Deduplicated the "stop/start running valves + notify onValveFlowChange" sequence into shared `stopRunningValves()`/`resumeRunningValves()` helpers used by `pause()`, `setRainPause()`, `setWindPause()`, `manualStartValve()`/`finishManualRun()`, and `onLegalRestrictionChanged()`, and the Homematic `ON_TIME` best-effort write into a shared `setHomematicOnTime()` helper used by both `start()` and `stop()` — reduces the risk of these near-identical code paths silently diverging
* (Gerhard Steinwedel) **ENHANCED**: `automation.status`'s remaining-minutes text during a manual single-valve run is now only re-published when the displayed value actually changes, instead of on every 1-second tick
* (Gerhard Steinwedel) **FIXED**: Homematic `stop()` no longer skips the critical `STATE=false` command if the best-effort `ON_TIME` reset fails — mirrors the existing `start()` handling so a failed `ON_TIME` write can never leave the physical actuator open while the adapter reports it as stopped
* (Gerhard Steinwedel) **FIXED**: Resuming automation after a manual single-valve run (`manualStartValve`) now correctly restarts the batch that was interrupted, instead of skipping it via an off-by-one in the batch index handed to `startNextBatch()`
* (Gerhard Steinwedel) **FIXED**: `waterConsumption.week`/`.month` no longer reset to 0 on every valve-close event that happens to fall on a Monday/1st-of-month — only on the first one, so consumption already recorded earlier that same day is no longer discarded
* (Gerhard Steinwedel) **FIXED**: `onMessage` no longer throws when a `sendTo` message payload is `null`
* (Gerhard Steinwedel) **FIXED**: `io-package.json`'s native config template had a stale `zonePause` field (never read; the actual field is `valvePause`) and was missing `nextValveId`; both are now aligned with `config-defaults.ts`/`types.ts`
* (Gerhard Steinwedel) **FIXED**: A valve disabled mid-run can now still be stopped through the adapter (`ValveController.stop()` now reconciles its `running` state even while `enabled=false`, instead of silently no-op'ing forever)
* (Gerhard Steinwedel) **FIXED**: Stopping a Rainbird valve with no `allOffId` configured no longer silently reports "stopped" in ioBroker with no hardware command ever sent — now logged as a warning and recorded in `errorLast`
* (Gerhard Steinwedel) **FIXED**: Water-consumption tracking (`onValveFlowChange`) now also fires for valves stopped/restarted by `pause()`/`resume()`, `manualStartValve()`, and legal-restriction pause/resume — previously consumption kept accruing as "flowing" after these events
* (Gerhard Steinwedel) **FIXED**: `automation.status`'s remaining-minutes text now updates every tick during a manual single-valve run instead of only at start/end
* (Gerhard Steinwedel) **FIXED**: `info.connection` is now set to `false`/`true` on Weather-API and DWD network fetch failures/successes, per the project's documented error-handling convention
* (Gerhard Steinwedel) **FIXED**: `watchdog.flowActive` (leak/deviation indicator) is now cleared again once flow stops or a valve legitimately runs again, instead of staying stuck at `true` forever after the first event
* (Gerhard Steinwedel) **FIXED**: `createPlan` now rejects duplicate plan names (matching the existing `renamePlan` check), preventing two plans from colliding into a single `automation.planSelect`/`startPlan` dropdown entry
* (Gerhard Steinwedel) **FIXED**: `deleteValvesByStateId` and `applyPlanValveTable` message handlers no longer assume their payload arrays are actually arrays, and `onMessage`'s `planName` reads are now type-checked instead of blindly cast
* (Gerhard Steinwedel) **ENHANCED**: `automation.temperatureAdjustmentStateId` is now read-only (`write: false`), consistent with every other `*StateId` mirror-of-config state
* (Gerhard Steinwedel) **ENHANCED**: Renamed `automation.currentZone`/`automation.batchZones` to `automation.currentValve`/`automation.batchValves` — these always indexed into valves, never into the separate `zones` object branch; stale objects are automatically removed on startup
* (Gerhard Steinwedel) **ENHANCED**: Added expert-mode valve-table columns for `enabled`, `flowRateLpm`, `rainIndependent`, `moistureThreshold`, `manualDuration`, `allOffId`, and `flowSensorId` — previously these always-present config fields had no admin UI at all
* (Gerhard Steinwedel) **ENHANCED**: `watchdog.flowActive` now uses the more specific `indicator.alarm` role instead of the generic `indicator`, consistent with `legalRestriction.active`
* (Gerhard Steinwedel) **ENHANCED**: `SensorManager` now releases its foreign-state subscriptions on adapter unload, consistent with the other subsystems' cleanup discipline
* (Gerhard Steinwedel) **ENHANCED**: Weather API no longer defaults a missing/invalid temperature reading to `0`°C (which looked like a real reading); it now keeps the last known value and logs a warning instead
* (Gerhard Steinwedel) **ENHANCED**: Flow calibration (`startCalibration`) now cleans up its bookkeeping if opening the valve fails, instead of leaving that valve's calibration state wedged until an adapter restart
* (Gerhard Steinwedel) **ENHANCED**: Renamed the built-in default plan name from the German "Alle" to the English "All", consistent with the project's English-only code/defaults convention (only affects new installs/plans; existing configured plan names are unaffected)
* (Gerhard Steinwedel) **ENHANCED**: All configured valves are now unconditionally switched off on every adapter start/restart, guaranteeing a consistent "all off" state regardless of prior automation status or externally-controlled valves — replaces the previous behavior of only stopping valves recorded as part of an interrupted `automation.batchZones` run

## 0.3.8 (2026-07-25)
* (Gerhard Steinwedel) **FIXED**: `automation.remainingDuration`/`remainingDurationMin` are now recalculated when the "Next"/"Back" batch buttons (`automation.next`/`automation.back`) are used — previously the remaining-time estimate stayed based on the original linear run timeline and became wrong once a batch was skipped or repeated
* (Gerhard Steinwedel) **ENHANCED**: Renamed `remainingTime` state to `remainingDuration` (both `automation.remainingTime` and per-valve `valves.valve_XXX.remainingTime`) for consistency with `remainingDurationMin`; stale `remainingTime` objects are automatically removed on startup

## 0.3.7 (2026-07-25)
* (Gerhard Steinwedel) **NEW**: Added formatted duration display (`remainingDurationMin`) showing remaining time in mm:ss format for both automation and individual valves — improves readability in UI compared to raw seconds

## 0.3.6 (2026-07-25)
* (Gerhard Steinwedel) **FIXED**: Deleted or renamed plans no longer linger in `automation.planSelect` and `automation.startPlan` dropdowns — `extendObjectAsync` deep-merges `common.states` instead of replacing it, so old plan entries would persist forever. New `replaceObjectStates()` method explicitly replaces the entire `states` map to ensure stale entries are removed

## 0.3.5 (2026-07-25)
* (Gerhard Steinwedel) **ENHANCED**: Valves now have stable, never-reused IDs that persist across reordering — moving a valve up/down in the admin table no longer changes its ioBroker object ID (`valves.valve_XXX`) or state history. Existing configurations are automatically migrated, with each valve receiving its current array position as its initial ID to preserve existing object IDs and history

## 0.3.4 (2026-07-25)
*(No user-visible changes — documentation and asset updates only)*

## 0.3.3 (2026-07-25)
* (Gerhard Steinwedel) **ENHANCED**: Valve duration formatting centralized in `formatValvesForNative()` method to ensure consistent conversion of numeric seconds to "HH:MM:SS"/"MM:SS" display strings whenever valves are written to native config or returned to admin UI — eliminates duplication across migration, write, and scan-response code paths.

## 0.3.2 (2026-07-25)
* (Gerhard Steinwedel) **ENHANCED**: Scan progress message now remains visible for 10 seconds after scan completion before being automatically cleared — admin UI hides the progress field when empty. Timer is cleaned up on new scans and adapter shutdown.

## 0.3.1 (2026-07-25)
* (Gerhard Steinwedel) **ENHANCED**: Valve durations now stored and processed in seconds instead of minutes — admin UI accepts flexible input formats (minutes, MM:SS, HH:MM:SS) and normalizes to display format. Legacy migration converts old minute values automatically. State units changed from `min` to `s`.

## 0.3.0 (2026-07-25)
* (Gerhard Steinwedel) **NEW**: Added wind speed/gust limits with resume hysteresis as an automatic pause condition
* (Gerhard Steinwedel) **ENHANCED**: Added unit tests for per-valve-type start/stop/status (Gardena, Homematic, Hydrawise, Generic), the DWD/local/no-source legal restriction, and a full-plan-run test for the temperature-controlled irrigation adjustment
* (Gerhard Steinwedel) **ENHANCED**: Added build.sh --dry-run/--no-deploy/--help and an admin hint that the Valves tab order is authoritative
* (Gerhard Steinwedel) **FIXED**: Legacy fields (e.g. valveOrder) that were only dropped in memory now trigger a one-time cleanup rewrite of automation.plansData
* (Gerhard Steinwedel) **ENHANCED**: Reduced plansData debug logging to a concise count instead of a full JSON dump
* (Gerhard Steinwedel) **ENHANCED**: Extracted plan/valve synchronization into a tested pure function covering valve add/remove/rename regressions
* (Gerhard Steinwedel) **FIXED**: Removed stale plan valve table order hint and misleading row-number column that contradicted the global Valves tab order
* (Gerhard Steinwedel) **ENHANCED**: Updated the architecture status with current irrigation features
* (Gerhard Steinwedel) **NEW**: Added automatic pause and resume of watering plans during rain
* (Gerhard Steinwedel) **ENHANCED**: Added wind, precipitation, ET and flow-monitoring roadmap items
* (Gerhard Steinwedel) **ENHANCED**: Expanded the adapter roadmap with operation, import/export and dashboard tasks
* (Gerhard Steinwedel) **ENHANCED**: Updated the adapter implementation plan with completed and open work

## 0.2.55 (2026-07-24)
* (Gerhard Steinwedel) **ENHANCED**: Unified sequential plan execution order with the Valves tab order
* (Gerhard Steinwedel) **FIXED**: Reserved space for all valve table action buttons

## 0.2.54 (2026-07-24)
* (Gerhard Steinwedel) **FIXED**: Kept valve reorder arrows available by disabling valve table sorting

## 0.2.53 (2026-07-24)
* (Gerhard Steinwedel) **FIXED**: Enabled both table reorder arrows for valves

## 0.2.52 (2026-07-24)
* (Gerhard Steinwedel) **ENHANCED**: Disabled manual release review prompts for automated releases

## 0.2.51 (2026-07-24)
* (Gerhard Steinwedel) **ENHANCED**: Made release-script confirmations automatic
* (Gerhard Steinwedel) **FIXED**: Restored reliable plan valve order serialization in the admin table

## 0.2.50 (2026-07-24)
* (Gerhard Steinwedel) **ENHANCED**: Plan valve order now uses native table arrow buttons instead of dedicated move controls — the dropdown and up/down buttons were removed; users drag or click table arrows to reorder valves, then apply changes. Simplifies UI and aligns with standard JSONConfig table behavior

## 0.2.49 (2026-07-24)
* (Gerhard Steinwedel) **FIXED**: Added direct persistent move controls for plan valve order

## 0.2.48 (2026-07-24)
* (Gerhard Steinwedel) **ENHANCED**: Plans now track valves by stable state IDs instead of array indexes — `valveStateIds`, `valveOrderStateIds`, and `knownValveStateIds` added to plan config. Prevents assignment loss when valves are renamed, reordered, added, or deleted. New valves are automatically added to existing plans unless explicitly empty. Legacy `valveIndexes` and `valveOrder` are migrated on adapter start and kept in sync for backward compatibility

## 0.2.47 (2026-07-24)
* (Gerhard Steinwedel) **FIXED**: Persisted explicit valve order for every irrigation plan

## 0.2.46 (2026-07-24)
* (Gerhard Steinwedel) **FIXED**: Removed the repeating plan assignment confirmation dialog

## 0.2.45 (2026-07-24)
* (Gerhard Steinwedel) **ENHANCED**: Valve assignment confirmation dialog now explicitly enabled with `condition: true` to ensure the dialog is always shown and gives the table debounce time to persist the current valve order before saving

## 0.2.44 (2026-07-24)
* (Gerhard Steinwedel) **FIXED**: Ensured reordered plan valves are persisted after table updates

## 0.2.43 (2026-07-23)
* (Gerhard Steinwedel) **FIXED**: Updated plan execution numbers immediately after moving table rows

## 0.2.42 (2026-07-23)
* (Gerhard Steinwedel) **FIXED**: Refreshed valve names from the object tree during scans and corrected plan numbering

## 0.2.41 (2026-07-23)
* (Gerhard Steinwedel) **FIXED**: Restored native table arrow controls for ordered plan valves

## 0.2.40 (2026-07-23)
* (Gerhard Steinwedel) **FIXED**: Added dedicated persistent move controls for ordered plan valves

## 0.2.39 (2026-07-23)
* (Gerhard Steinwedel) **FIXED**: Persisted and reloaded the valve order of each plan reliably

## 0.2.38 (2026-07-23)
* (Gerhard Steinwedel) **ENHANCED**: Combined plan creation and renaming into one plan-name input

## 0.2.37 (2026-07-23)
* (Gerhard Steinwedel) **NEW**: Added plan renaming with name validation in the plan editor

## 0.2.36 (2026-07-23)
* (Gerhard Steinwedel) **ENHANCED**: Renamed plan valve table column header from "Execution order" to "Number" with localized translations for all supported languages

## 0.2.35 (2026-07-23)
* (Gerhard Steinwedel) **FIXED**: Added a compatible visible sequential execution-order column to the plan valve table

## 0.2.34 (2026-07-23)
* (Gerhard Steinwedel) **ENHANCED**: Added visible sequential execution positions to the plan valve table

## 0.2.33 (2026-07-23)
* (Gerhard Steinwedel) **FIXED**: Restored the unified watering duration in the valve table

## 0.2.32 (2026-07-23)
* (Gerhard Steinwedel) **ENHANCED**: Unified direct and planned valve watering duration

## 0.2.31 (2026-07-23)
* (Gerhard Steinwedel) **FIXED**: Enabled native table arrow buttons to order sequential plan valves

## 0.2.30 (2026-07-23)
* (Gerhard Steinwedel) **ENHANCED**: Added configurable valve order for sequential watering plans

## 0.2.29 (2026-07-23)
* (Gerhard Steinwedel) **NEW**: Added temperature-controlled automatic plan duration adjustment
* (Gerhard Steinwedel) **FIXED**: Reset automation duration states when stopping a run

## 0.2.28 (2026-07-23)
* (Gerhard Steinwedel) **NEW**: Added Hydrawise valve control and auto-discovery through ioBroker.hydrawise
* (Gerhard Steinwedel) **ENHANCED**: Documented all ioBroker adapter data points and their usage in the README
* (Gerhard Steinwedel) **ENHANCED**: Published automation duration states as seconds instead of time-formatted minutes

## 0.2.27 (2026-07-23)
* (Gerhard Steinwedel) **NEW**: Added selectable direct plan starts through ioBroker states

## 0.2.26 (2026-07-22)
* (Gerhard Steinwedel) **ENHANCED**: Disabled and cleared restriction end date/time until their start values are configured

## 0.2.25 (2026-07-22)
* (Gerhard Steinwedel) **ENHANCED**: Disabled the maximum irrigation temperature without a configured temperature source
* (Gerhard Steinwedel) **ENHANCED**: Made restriction date and time ranges independently optional
* (Gerhard Steinwedel) **FIXED**: Validated annual dates such as 1.6 in the admin configuration

## 0.2.24 (2026-07-22)
* (Gerhard Steinwedel) **ENHANCED**: Added validated annual restriction dates and minute-precise start and end times

## 0.2.23 (2026-07-22)
* (Gerhard Steinwedel) **ENHANCED**: Made DWD station and local temperature state selection mutually exclusive
* (Gerhard Steinwedel) **NEW**: Added a selectable local temperature state as an alternative source for the legal restriction

## 0.2.22 (2026-07-22)
* (Gerhard Steinwedel) **ENHANCED**: Added an option to apply the legal restriction without a DWD temperature check

## 0.2.21 (2026-07-22)
* (Gerhard Steinwedel) **ENHANCED**: Added all DWD POI weather stations to the legal restriction station dropdown

## 0.2.20 (2026-07-22)
* (Gerhard Steinwedel) **ENHANCED**: Replaced the free-text DWD station ID with a station-name dropdown in the legal restriction settings

## 0.2.19 (2026-07-22)
* (Gerhard Steinwedel) **ENHANCED**: Rainbird valves on the same controller instance are now automatically prevented from running in parallel batches — a Rainbird controller can only physically open one station at a time, and the shared `stopIrrigation` command would otherwise interrupt all zones. Valves on different Rainbird controllers and non-Rainbird valves can still be batched together normally
* (Gerhard Steinwedel) **ENHANCED**: The all-off state ID (master stop for Gardena/Rainbird controllers) is now detected and managed automatically — the manual configuration column has been removed from the admin UI. ValveController implements a safety check to prevent sending the controller-wide stop command while other zones on the same Rainbird controller are still running

## 0.2.18 (2026-07-22)
* (Gerhard Steinwedel) **ENHANCED**: Reordered the "Valves in selected plan" table so the "In plan" checkbox is now the first column. Removed the "Add all valves to plan"/"Remove all valves from plan" quick action buttons — use the "In plan" checkbox column together with "Apply valve assignment" instead

## 0.2.17 (2026-07-22)
* (Gerhard Steinwedel) **FIXED**: "Apply valve assignment" in the Plans tab now correctly maps table rows back to their real valve indexes via the stable `valveNumber` column instead of the row's position in the table — the "Valves in selected plan" table allowed sorting/reordering rows (e.g. by clicking the "Name" column header), and after such a reorder the old position-based mapping silently assigned the wrong valves to the plan. The table no longer allows adding, deleting, or manually reordering rows (`noDelete: true`) to keep row identity stable; sorting by column remains possible and safe since matching is now done via `valveNumber`

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