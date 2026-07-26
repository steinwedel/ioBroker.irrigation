"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_config_defaults = require("./lib/config-defaults");
var import_duration = require("./lib/duration");
var import_valve_editor = require("./lib/valve-editor");
var import_types = require("./lib/types");
var import_states = require("./lib/states");
var import_ventile = require("./lib/ventile");
var import_automation = require("./lib/automation");
var import_scheduler = require("./lib/scheduler");
var import_sensors = require("./lib/sensors");
var import_wind = require("./lib/wind");
var import_dwd = require("./lib/dwd");
var import_dwd_poi_stations = require("./lib/dwd-poi-stations");
var import_water_consumption = require("./lib/water-consumption");
var import_weather_api = require("./lib/weather-api");
var import_notifications = require("./lib/notifications");
var import_flow_monitor = require("./lib/flow-monitor");
var import_valvescanner = require("./lib/valvescanner");
var import_rate_limiter = require("./lib/rate-limiter");
function readPlanIndex(message) {
  const value = message == null ? void 0 : message._editPlan;
  return typeof value === "number" ? value : void 0;
}
function readPlanName(message) {
  const value = message == null ? void 0 : message.planName;
  return typeof value === "string" ? value.trim() : void 0;
}
function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aObj = a;
    const bObj = b;
    const aKeys = Object.keys(aObj).filter((key) => aObj[key] !== void 0);
    const bKeys = Object.keys(bObj).filter((key) => bObj[key] !== void 0);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]));
  }
  return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
}
class Irrigation extends utils.Adapter {
  config2;
  valves = [];
  automation;
  scheduler;
  sensorManager;
  windMonitor;
  dwd;
  waterConsumption;
  weatherApi;
  notifications;
  flowMonitor;
  rateLimiter;
  rateLimiterPoll;
  scanProgressClearTimer;
  isScanning = false;
  constructor(options = {}) {
    super({
      ...options,
      name: "irrigation"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    this.config2 = (0, import_config_defaults.normalizeConfig)(this.config);
    await this.migrateNativeConfig();
    await this.cleanupStaleValveObjects();
    await this.cleanupStaleZoneObjects();
    await (0, import_states.createBaseStates)(this);
    await this.loadPlansState();
    await (0, import_states.applyConfigToStates)(this, this.config2);
    this.rateLimiter = new import_rate_limiter.RateLimiter();
    await this.createRateLimitStates();
    this.valves = this.config2.valves.map(
      (valveConfig, index) => new import_ventile.ValveController(
        this,
        index,
        valveConfig,
        this.rateLimiter,
        () => this.valves,
        (requestedOn) => this.automation.manualSetValveState(index, requestedOn)
      )
    );
    for (const valve of this.valves) {
      await valve.init();
    }
    this.notifications = new import_notifications.NotificationManager({ adapter: this, getConfig: () => this.config2 });
    this.sensorManager = new import_sensors.SensorManager({
      adapter: this,
      getConfig: () => this.config2,
      onRainChange: (raining) => {
        var _a;
        return (_a = this.automation) == null ? void 0 : _a.setRainPause(raining);
      }
    });
    await this.sensorManager.init();
    this.windMonitor = new import_wind.WindMonitor({
      adapter: this,
      getConfig: () => this.config2,
      onWindPauseChange: (paused) => {
        var _a, _b;
        return (_b = (_a = this.automation) == null ? void 0 : _a.setWindPause(paused)) != null ? _b : Promise.resolve();
      }
    });
    await this.windMonitor.init();
    this.waterConsumption = new import_water_consumption.WaterConsumptionTracker({ adapter: this, getConfig: () => this.config2 });
    await this.waterConsumption.init();
    this.flowMonitor = new import_flow_monitor.FlowMonitor({
      adapter: this,
      getConfig: () => this.config2,
      notifications: this.notifications,
      getRunningValveIndexes: () => this.valves.map((v, i) => v.isRunning() ? i : -1).filter((i) => i >= 0)
    });
    await this.flowMonitor.init();
    this.automation = new import_automation.AutomationEngine({
      adapter: this,
      getConfig: () => this.config2,
      valves: this.valves,
      isValveBlockedForAutoRun: (valveIndex) => this.sensorManager.isValveBlocked(valveIndex),
      isLegallyRestricted: () => this.dwd.isActive(),
      isRaining: () => this.sensorManager.isRaining(),
      isWindOverLimit: () => this.windMonitor.isOverLimit(),
      getTemperatureAdjustmentTemperature: () => this.sensorManager.getTemperatureAdjustmentTemperature(),
      onValveFlowChange: (valveIndex, flowing) => this.waterConsumption.onValveFlowChange(valveIndex, flowing)
    });
    this.automation.start();
    await this.automation.recoverAfterRestart();
    this.dwd = new import_dwd.DwdRestriction({
      adapter: this,
      getConfig: () => this.config2,
      onRestrictionChanged: (active) => this.automation.onLegalRestrictionChanged(active)
    });
    await this.dwd.init();
    this.scheduler = new import_scheduler.Scheduler({
      adapter: this,
      getConfig: () => this.config2,
      onTrigger: (planName, source) => this.handleSchedulerTrigger(planName, source),
      isFrostBlocked: () => this.sensorManager.isFrostBlocked(),
      isSeasonBlocked: () => this.sensorManager.isSeasonBlocked()
    });
    await this.scheduler.init();
    this.weatherApi = new import_weather_api.WeatherApi({ adapter: this, getConfig: () => this.config2 });
    await this.weatherApi.init();
    this.subscribeStates("automation.*");
    this.subscribeStates("valves.*.manualStart");
    this.subscribeStates("valves.*.calibrateFlow");
    this.subscribeStates("valves.*.duration");
    this.subscribeStates("watchdog.testNotify");
    this.subscribeStates("valves.*.state");
    await this.setStateAsync("info.connection", { val: true, ack: true });
    this.rateLimiterPoll = this.setInterval(() => this.updateRateLimitStates(), 1e4);
  }
  /**
   * Persists newly introduced or migrated valve config fields.
   * plus a display-only "valveNumber" (e.g. "valve_2") back into `native` so the
   * admin config table shows real, editable/readable values for existing entries
   * instead of blanks. Only writes when something actually changed, since
   * updating our own instance's `native` triggers an adapter restart.
   *
   * Also assigns each pre-existing valve a stable `id` (defaulting to its
   * current array index, so its real object id/state history is preserved
   * across the upgrade - see the `IValveConfig.id` doc comment) and
   * initializes `nextValveId` so future newly-added valves get ids that
   * never collide with or get reused from an existing one.
   */
  async migrateNativeConfig() {
    var _a;
    const rawValves = (_a = this.config.valves) != null ? _a : [];
    const formattedValves = this.formatValvesForNative(this.config2.valves);
    const migratedValves = formattedValves.map((valve, index) => {
      var _a2;
      return {
        ...valve,
        valveNumber: `valve_${(0, import_types.formatValveNumber)((_a2 = this.config2.valves[index].id) != null ? _a2 : index)}`
      };
    });
    const needsIdMigration = rawValves.some((raw) => typeof raw.id !== "number");
    const needsValveMigration = rawValves.length !== migratedValves.length || rawValves.some((raw) => !raw.valveNumber || "runFor" in raw || typeof raw.duration === "number") || needsIdMigration;
    if (needsValveMigration) {
      this.log.info("Migrating native.valves to remove runFor, include valveNumber and stable id.");
      const maxAssignedId = this.config2.valves.reduce((max, valve) => {
        var _a2;
        return Math.max(max, (_a2 = valve.id) != null ? _a2 : -1);
      }, -1);
      const nextValveId = Math.max(this.config2.nextValveId, maxAssignedId + 1);
      await this.writeNativeAsync({ valves: migratedValves, nextValveId });
    }
  }
  /**
   * Loads `plans` from the dedicated `automation.plansData` state into
   * `this.config2.plans`, migrating the legacy `native.plans` value into
   * that state once if the state doesn't hold anything useful yet.
   *
   * Plans are intentionally NOT stored in `native` config (unlike every
   * other setting): the admin UI's Plans tab lets users add/delete plans
   * and (re)assign valves via `sendTo` buttons while the settings dialog
   * is open, and writing to native config always triggers a full adapter
   * instance restart (this is unconditional js-controller behavior,
   * regardless of write method). Restarting mid-edit breaks the "Selected
   * plan" dropdown: its option list re-fetch can land in the brief window
   * where `alive` is `false` during the restart, after which nothing
   * re-triggers the fetch, leaving the dropdown empty until the page is
   * reloaded. A plain adapter state write never restarts the adapter, so
   * `plans` lives there instead. Must run after createBaseStates() (which
   * creates `automation.plansData`) and before anything that reads
   * `this.config2.plans`.
   */
  async loadPlansState() {
    const plansState = await this.getStateAsync("automation.plansData");
    const storedPlans = this.parsePlansState(plansState == null ? void 0 : plansState.val);
    if (storedPlans && storedPlans.length > 0) {
      const synchronizedPlans = this.synchronizePlansWithValves(storedPlans);
      this.log.debug(`Loaded ${synchronizedPlans.length} plan(s) from automation.plansData.`);
      const hasLegacyFields = this.plansStateHasLegacyFields(plansState == null ? void 0 : plansState.val);
      if (hasLegacyFields || !deepEqual(synchronizedPlans, storedPlans)) {
        if (hasLegacyFields) {
          this.log.info("Removing legacy fields (e.g. valveOrder) from automation.plansData.");
        }
        await this.writePlansState(synchronizedPlans);
      } else {
        this.config2.plans = synchronizedPlans;
        await this.publishPlanNames(synchronizedPlans);
      }
      return;
    }
    this.log.info("Initializing automation.plansData state from existing configuration.");
    await this.writePlansState(this.config2.plans);
  }
  parsePlansState(raw) {
    if (typeof raw !== "string" || !raw) {
      return void 0;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return void 0;
      }
      return parsed.map((p) => {
        var _a;
        return {
          name: (_a = p == null ? void 0 : p.name) != null ? _a : "",
          valveIndexes: Array.isArray(p == null ? void 0 : p.valveIndexes) ? p.valveIndexes : [],
          valveStateIds: Array.isArray(p == null ? void 0 : p.valveStateIds) ? p.valveStateIds : void 0,
          knownValveStateIds: Array.isArray(p == null ? void 0 : p.knownValveStateIds) ? p.knownValveStateIds : void 0
        };
      });
    } catch (err) {
      this.log.warn(`Failed to parse automation.plansData state, ignoring: ${err.message}`);
      return void 0;
    }
  }
  /**
   * True if the raw automation.plansData JSON contains fields that are no
   * longer part of IPlanConfig (e.g. the legacy `valveOrder`/`valveOrderStateIds`
   * arrays used by an earlier per-plan ordering implementation). parsePlansState()
   * silently drops such fields when parsing into memory, so comparing the
   * in-memory representation before/after synchronization would never detect
   * them and the stale fields would otherwise linger in the persisted state
   * forever. Used by loadPlansState() to force one cleanup rewrite.
   *
   * @param raw
   */
  plansStateHasLegacyFields(raw) {
    if (typeof raw !== "string" || !raw) {
      return false;
    }
    const knownFields = /* @__PURE__ */ new Set(["name", "valveIndexes", "valveStateIds", "knownValveStateIds"]);
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.some(
        (p) => typeof p === "object" && p !== null && Object.keys(p).some((key) => !knownFields.has(key))
      );
    } catch {
      return false;
    }
  }
  synchronizePlansWithValves(plans) {
    const currentStateIds = this.config2.valves.map((valve) => valve.stateId);
    return plans.map((plan) => (0, import_types.synchronizePlanWithValves)(plan, currentStateIds));
  }
  /**
   * Persists `plans` to the `automation.plansData` state and refreshes
   * `this.config2.plans` in-memory. Deliberately does NOT touch `native`
   * config - see loadPlansState() for why. Also mirrors the plan names
   * into automation.plansList (as before) so any external consumers of
   * that JSON state keep working unchanged.
   *
   * @param plans
   */
  async writePlansState(plans) {
    const synchronizedPlans = this.synchronizePlansWithValves(plans);
    this.config2.plans = synchronizedPlans;
    this.log.debug(`Persisting ${synchronizedPlans.length} plan(s) to automation.plansData.`);
    await this.setStateAsync("automation.plansData", { val: JSON.stringify(synchronizedPlans), ack: true });
    await this.publishPlanNames(synchronizedPlans);
  }
  async publishPlanNames(plans) {
    const planNames = plans.map((plan) => plan.name);
    const states = Object.fromEntries(planNames.map((planName) => [planName, planName]));
    await this.setStateAsync("automation.plansList", { val: JSON.stringify(planNames), ack: true });
    await this.replaceObjectStates("automation.planSelect", states);
    await this.replaceObjectStates("automation.startPlan", states);
  }
  /**
   * Fully replaces `common.states` on the given object instead of merging
   * it, since `extendObjectAsync` deep-merges nested objects and would
   * otherwise never drop keys for plans that were deleted or renamed.
   *
   * @param id
   * @param states
   */
  async replaceObjectStates(id, states) {
    const obj = await this.getObjectAsync(id);
    if (!obj) {
      return;
    }
    obj.common = { ...obj.common, states };
    await this.setObjectAsync(id, obj);
  }
  /**
   * Creates the smartgarden rate limit monitoring states.
   */
  async createRateLimitStates() {
    await this.setObjectNotExistsAsync("smartgardenRateLimit", {
      type: "channel",
      common: { name: "Smartgarden API rate limit" },
      native: {}
    });
    await this.setObjectNotExistsAsync("smartgardenRateLimit.window10sCount", {
      type: "state",
      common: {
        name: "Requests in 10s window",
        type: "number",
        role: "value",
        read: true,
        write: false,
        def: 0
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("smartgardenRateLimit.weeklyCount", {
      type: "state",
      common: {
        name: "Requests in 7-day window",
        type: "number",
        role: "value",
        read: true,
        write: false,
        def: 0
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("smartgardenRateLimit.lastRequest", {
      type: "state",
      common: {
        name: "Timestamp of last request (ms epoch)",
        type: "number",
        role: "value",
        read: true,
        write: false,
        def: 0
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("smartgardenRateLimit.nextSlot", {
      type: "state",
      common: {
        name: "Timestamp when next slot opens (ms epoch, 0 = now)",
        type: "number",
        role: "value",
        read: true,
        write: false,
        def: 0
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("smartgardenRateLimit.queueLength", {
      type: "state",
      common: {
        name: "Number of pending requests in queue",
        type: "number",
        role: "value",
        read: true,
        write: false,
        def: 0
      },
      native: {}
    });
  }
  async updateRateLimitStates() {
    const state = this.rateLimiter.getState();
    await this.setStateAsync("smartgardenRateLimit.window10sCount", { val: state.window10sCount, ack: true });
    await this.setStateAsync("smartgardenRateLimit.weeklyCount", { val: state.weeklyCount, ack: true });
    await this.setStateAsync("smartgardenRateLimit.lastRequest", { val: state.lastRequest, ack: true });
    await this.setStateAsync("smartgardenRateLimit.nextSlot", { val: state.nextSlot, ack: true });
    await this.setStateAsync("smartgardenRateLimit.queueLength", { val: state.queueLength, ack: true });
  }
  /**
   * Deletes leftover `valves.valve_N` objects (and their child states) that no
   * longer correspond to any entry in the current `native.valves` config.
   * This covers two cases:
   *
   *  1. Objects whose numeric suffix is not zero-padded to 3 digits, i.e.
   *     objects created before valve object ids were changed from
   *     `valves.valve_0` to `valves.valve_000`.
   *  2. Objects whose (zero-padded) index is >= the number of valves
   *     currently configured, i.e. leftovers from a previous, larger valve
   *     list (e.g. after a re-scan found fewer valves, or rows were removed
   *     from the Valves table in admin). Without this, the orphaned object
   *     keeps reacting to nothing (no ValveController is created for it
   *     anymore) while still looking like a normal, configured valve to the
   *     user - this was reported as "changing valve_054.state does nothing"
   *     after the valve list shrank from 61 to 50 entries and that
   *     particular valve (now valve_043) kept its old id around.
   *
   * ValveController.init() only ever creates/updates the ids for valves
   * still present in the config via setObjectNotExistsAsync/extendObjectAsync,
   * so without this cleanup both kinds of stale objects are left behind as
   * orphans indefinitely.
   *
   * Safety: case 2 is skipped entirely when the config's valve list is
   * empty. An empty list at this point could mean the user genuinely
   * deleted all valves, but it is indistinguishable here from `this.config`
   * transiently/erroneously arriving empty (e.g. a stale/partial adapter
   * config read). Since "Delete all valves" in admin already removes the
   * objects itself, skipping the range-based cleanup on an empty list only
   * risks leaving orphans around a little longer in the rare genuine-empty
   * case, whereas NOT skipping it risks wiping out every valve object
   * (losing calibration/state history) on a transient empty read - a much
   * worse outcome that was observed in practice.
   */
  async cleanupStaleValveObjects() {
    const channels = await this.getForeignObjectsAsync(`${this.namespace}.valves.*`, "channel");
    const stalePattern = /^valves\.valve_(\d+)$/;
    const configuredValveCount = this.config2.valves.length;
    const checkRange = configuredValveCount > 0;
    for (const id of Object.keys(channels)) {
      const localId = id.slice(this.namespace.length + 1);
      const match = stalePattern.exec(localId);
      if (!match) {
        continue;
      }
      const isUnpadded = match[1].length !== 3;
      const isOutOfRange = checkRange && parseInt(match[1], 10) >= configuredValveCount;
      if (isUnpadded || isOutOfRange) {
        const reason = isUnpadded ? "un-padded legacy id" : `index >= configured valve count (${configuredValveCount})`;
        this.log.info(`Removing stale valve object "${id}" (${reason}).`);
        await this.delObjectAsync(localId, { recursive: true }).catch(
          (error) => this.log.warn(`Failed to remove stale valve object "${id}": ${error.message}`)
        );
      }
    }
  }
  /**
   * Removes legacy zone objects (zones.*) — zones were removed in v0.2.0.
   */
  async cleanupStaleZoneObjects() {
    try {
      await this.delObjectAsync("zones", { recursive: true });
      this.log.info("Removed legacy zone objects (zones removed in v0.2.0).");
    } catch {
    }
  }
  async handleSchedulerTrigger(planName, source) {
    var _a, _b;
    if (source === "ical") {
      const activeTitle = await this.tryResolveIcalTitle();
      if (activeTitle) {
        planName = (0, import_scheduler.resolvePlanFromIcalTitle)(
          activeTitle,
          this.config2.scheduler.icalTitlePrefix,
          this.config2.plans.map((p) => p.name),
          (_b = (_a = this.config2.plans[0]) == null ? void 0 : _a.name) != null ? _b : "All"
        );
      }
    }
    await this.automation.requestRun(planName, source);
  }
  async tryResolveIcalTitle() {
    const icalInstance = this.config2.scheduler.icalAdapterInstance;
    if (!icalInstance) {
      return void 0;
    }
    try {
      const dataTable = await this.getForeignStateAsync(`${icalInstance}.data.table`);
      const raw = dataTable == null ? void 0 : dataTable.val;
      if (typeof raw !== "string" || !raw) {
        return void 0;
      }
      const events = JSON.parse(raw);
      if (!Array.isArray(events)) {
        return void 0;
      }
      const prefixLower = this.config2.scheduler.icalTitlePrefix.toLowerCase();
      const now = Date.now();
      let best;
      for (const evt of events) {
        if (!evt.event || typeof evt.event !== "string") {
          continue;
        }
        if (!evt.event.toLowerCase().startsWith(prefixLower)) {
          continue;
        }
        const startTs = evt._date ? new Date(evt._date).getTime() : NaN;
        const endTs = evt._end ? new Date(evt._end).getTime() : NaN;
        if (isNaN(startTs) || isNaN(endTs)) {
          continue;
        }
        if (now < startTs || now >= endTs) {
          continue;
        }
        if (!best || startTs < best.start) {
          best = { event: evt.event, start: startTs };
        }
      }
      return best == null ? void 0 : best.event;
    } catch (error) {
      this.log.warn(`Failed to resolve ical event title: ${error.message}`);
      return void 0;
    }
  }
  /**
   * Runs a single cleanup step, logging (but never throwing) any error so
   * that one module's failed destroy() can never prevent the cleanup of
   * all subsequent modules. Awaits the result in case destroy() ever
   * starts returning a Promise.
   *
   * @param label Name of the module being destroyed, used in the log message.
   * @param destroyFn The cleanup callback to run.
   */
  async safeDestroy(label, destroyFn) {
    try {
      await destroyFn();
    } catch (error) {
      this.log.error(`Error destroying ${label} during unload: ${error.message}`);
    }
  }
  async onUnload(callback) {
    try {
      if (this.rateLimiterPoll) {
        this.clearInterval(this.rateLimiterPoll);
        this.rateLimiterPoll = void 0;
      }
      if (this.scanProgressClearTimer) {
        this.clearTimeout(this.scanProgressClearTimer);
        this.scanProgressClearTimer = void 0;
      }
      await this.safeDestroy("rateLimiter", () => {
        var _a;
        return (_a = this.rateLimiter) == null ? void 0 : _a.destroy();
      });
      await this.safeDestroy("automation", () => {
        var _a;
        return (_a = this.automation) == null ? void 0 : _a.destroy();
      });
      await this.safeDestroy("scheduler", () => {
        var _a;
        return (_a = this.scheduler) == null ? void 0 : _a.destroy();
      });
      await this.safeDestroy("dwd", () => {
        var _a;
        return (_a = this.dwd) == null ? void 0 : _a.destroy();
      });
      await this.safeDestroy("windMonitor", () => {
        var _a;
        return (_a = this.windMonitor) == null ? void 0 : _a.destroy();
      });
      await this.safeDestroy("weatherApi", () => {
        var _a;
        return (_a = this.weatherApi) == null ? void 0 : _a.destroy();
      });
      await this.safeDestroy("flowMonitor", () => {
        var _a;
        return (_a = this.flowMonitor) == null ? void 0 : _a.destroy();
      });
      await this.safeDestroy("sensorManager", () => {
        var _a;
        return (_a = this.sensorManager) == null ? void 0 : _a.destroy();
      });
      for (const valve of this.valves) {
        await this.safeDestroy(`valve ${valve.id}`, () => valve.destroy());
      }
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
    } finally {
      callback();
    }
  }
  async onStateChange(id, state) {
    try {
      await this.handleStateChange(id, state);
    } catch (error) {
      this.log.error(`Error handling state change for "${id}": ${error.message}`);
    }
  }
  async handleStateChange(id, state) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    if (!state) {
      return;
    }
    if (!id.startsWith(`${this.namespace}.`)) {
      const matches = await Promise.all(
        this.valves.map(
          (valve) => valve.onForeignStateChange(id, state).catch((error) => {
            this.log.error(
              `Valve ${valve.id}: error handling foreign state change for "${id}": ${error.message}`
            );
            return false;
          })
        )
      );
      if (matches.some((matched) => matched)) {
        return;
      }
      const handledBySensor = (_b = await ((_a = this.sensorManager) == null ? void 0 : _a.onForeignStateChange(id, state))) != null ? _b : false;
      const handledByWind = (_d = await ((_c = this.windMonitor) == null ? void 0 : _c.onForeignStateChange(id, state))) != null ? _d : false;
      const handledByRestriction = (_f = await ((_e = this.dwd) == null ? void 0 : _e.onForeignStateChange(id, state))) != null ? _f : false;
      if (handledBySensor || handledByWind || handledByRestriction) {
        return;
      }
      if (await ((_g = this.scheduler) == null ? void 0 : _g.onForeignStateChange(id, state))) {
        return;
      }
      if (await ((_h = this.flowMonitor) == null ? void 0 : _h.onForeignStateChange(id, state))) {
        return;
      }
      return;
    }
    const localId = id.slice(this.namespace.length + 1);
    const valveStateMatch = /^valves\.valve_\d+\.state$/.exec(localId);
    if (valveStateMatch) {
      for (const valve of this.valves) {
        if (await valve.onOwnStateChange(localId, state)) {
          return;
        }
      }
      return;
    }
    if (state.ack) {
      return;
    }
    switch (localId) {
      case "automation.start":
        await this.setStateAsync(id, { val: false, ack: true });
        await this.automation.requestRun((_j = (_i = this.config2.plans[0]) == null ? void 0 : _i.name) != null ? _j : "All", "manual-button");
        return;
      case "automation.startPlan": {
        const planName = typeof state.val === "string" ? state.val.trim() : "";
        await this.setStateAsync(id, { val: "", ack: true });
        if (planName) {
          await this.automation.requestRun(planName, "manual-button");
        }
        return;
      }
      case "automation.stop":
        await this.setStateAsync(id, { val: false, ack: true });
        await this.automation.stop();
        return;
      case "automation.pause":
        await this.setStateAsync(id, { val: false, ack: true });
        await this.automation.pause();
        return;
      case "automation.next":
        await this.setStateAsync(id, { val: false, ack: true });
        await this.automation.next();
        return;
      case "automation.back":
        await this.setStateAsync(id, { val: false, ack: true });
        await this.automation.back();
        return;
      case "automation.active":
        this.config2.scheduler.autoMode = state.val === true;
        return;
      case "automation.planSelect":
        return;
      // stored, used on next requestRun
      case "watchdog.testNotify":
        await this.setStateAsync(id, { val: false, ack: true });
        await this.notifications.send("Bew\xE4sserung Test", "Dies ist eine Testbenachrichtigung.");
        return;
    }
    const valveManualStartMatch = /^valves\.valve_(\d+)\.manualStart$/.exec(localId);
    if (valveManualStartMatch) {
      await this.setStateAsync(id, { val: false, ack: true });
      const valveIndex = this.findValveIndexByObjectSuffix(parseInt(valveManualStartMatch[1], 10));
      if (valveIndex >= 0) {
        await this.automation.manualStartValve(valveIndex);
      }
      return;
    }
    const valveCalibrateMatch = /^valves\.valve_(\d+)\.calibrateFlow$/.exec(localId);
    if (valveCalibrateMatch) {
      await this.setStateAsync(id, { val: false, ack: true });
      const valveIndex = this.findValveIndexByObjectSuffix(parseInt(valveCalibrateMatch[1], 10));
      if (valveIndex >= 0) {
        await this.flowMonitor.startCalibration(
          valveIndex,
          // Explicitly pass the calibration window's own duration rather than
          // letting start() fall back to the valve's configured `duration`:
          // if that configured duration were shorter than
          // CALIBRATION_DURATION_SECS, the valve would auto-stop itself
          // mid-calibration while flow-monitor keeps sampling (now zero
          // flow) for the remainder of the window, skewing the average down.
          () => this.valves[valveIndex].start(import_flow_monitor.CALIBRATION_DURATION_SECS),
          () => this.valves[valveIndex].stop()
        );
      }
      return;
    }
    const valveMatch = /^valves\.valve_\d+\./.exec(localId);
    if (valveMatch) {
      for (const valve of this.valves) {
        if (await valve.onOwnStateChange(localId, state)) {
          return;
        }
      }
      return;
    }
  }
  /**
   * Writes a partial `native` update directly to our own instance object instead of
   * using extendForeignObjectAsync or returning `{native, saveConfig: true}` via a
   * sendTo response (which would pop up an extra "Save configuration?" confirmation
   * dialog in the admin UI). Writing the object directly persists it immediately and
   * triggers the usual adapter restart, without that extra dialog.
   *
   * Uses a full read-modify-write (getForeignObjectAsync + setForeignObjectAsync)
   * rather than extendForeignObjectAsync: extendObject's underlying deep-merge
   * (node.extend) treats arrays as index-keyed maps, so merging a shorter (or
   * differently-shaped) array/object into an existing one does not fully replace it -
   * stale elements/fields would survive. That, in turn, can make the same "needs
   * migration" check keep matching true on every restart (since the stale data never
   * actually gets overwritten), causing the adapter to restart itself in a loop. A
   * full read-modify-write always replaces the given top-level native keys outright.
   *
   * @param partialNative
   */
  async writeNativeAsync(partialNative) {
    var _a;
    const instanceObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
    if (instanceObj) {
      const mergedNative = { ...(_a = instanceObj.native) != null ? _a : {}, ...partialNative };
      instanceObj.native = mergedNative;
      await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instanceObj);
      this.config2 = (0, import_config_defaults.normalizeConfig)(mergedNative);
    }
  }
  /**
   * Converts valve durations (stored in `this.config2`/`IValveConfig` as
   * numeric seconds) back into the "HH:MM:SS"/"MM:SS" display string the
   * admin table's `duration`/`manualDuration` text fields expect (see
   * migrateNativeConfig() and admin/jsonConfig.json). Every write path that
   * persists valves to `native.valves` - or hands them back to an open
   * admin dialog via a `sendTo` response - must go through this so the
   * table never shows raw seconds.
   *
   * @param valves
   */
  formatValvesForNative(valves) {
    return valves.map((valve) => ({
      ...valve,
      duration: (0, import_duration.formatDuration)(valve.duration),
      manualDuration: (0, import_duration.formatDuration)(valve.manualDuration)
    }));
  }
  async writeValvesToNative(valves) {
    await this.writeNativeAsync({ valves: this.formatValvesForNative(valves) });
  }
  /**
   * Maps the numeric suffix of a `valves.valve_NNN.*` object id back to the
   * valve's current array index in `this.config2.valves`/`this.valves`. The
   * object suffix is the valve's stable `id` (see `IValveConfig.id`), which
   * can differ from its current array position once valves have been
   * reordered/deleted/re-added - so this must never be used directly as an
   * array index.
   *
   * @param numericSuffix
   */
  findValveIndexByObjectSuffix(numericSuffix) {
    return this.config2.valves.findIndex((valve, index) => {
      var _a;
      return ((_a = valve.id) != null ? _a : index) === numericSuffix;
    });
  }
  getPlanValveIndexes(planIndex) {
    var _a;
    const plan = planIndex !== void 0 && planIndex >= 0 && planIndex < this.config2.plans.length ? this.config2.plans[planIndex] : void 0;
    const allValveIndexes = this.config2.valves.map((_, index) => index);
    return plan && plan.valveIndexes.length === 0 ? allValveIndexes : ((_a = plan == null ? void 0 : plan.valveIndexes) != null ? _a : []).filter((index) => index >= 0 && index < this.config2.valves.length);
  }
  getPlanValveTable(planIndex) {
    const allValveIndexes = this.config2.valves.map((_, index) => index);
    const assignedIndexes = this.getPlanValveIndexes(planIndex);
    const assignedSet = new Set(assignedIndexes);
    return allValveIndexes.map((index) => {
      var _a;
      return {
        valveNumber: (0, import_types.formatValveNumber)((_a = this.config2.valves[index].id) != null ? _a : index),
        name: this.config2.valves[index].name || "unnamed",
        assigned: assignedSet.has(index)
      };
    });
  }
  async onMessage(obj) {
    try {
      await this.handleMessage(obj);
    } catch (error) {
      this.log.error(`Error handling message "${obj == null ? void 0 : obj.command}": ${error.message}`);
    }
  }
  async handleMessage(obj) {
    var _a, _b;
    if (obj === null || typeof obj !== "object" || !obj.command) {
      return;
    }
    if (obj.command === "scanValves") {
      if (this.isScanning) {
        this.log.warn("Valve scan requested while another scan is still running - rejecting.");
        if (obj.callback) {
          this.sendTo(
            obj.from,
            obj.command,
            {
              error: "scanInProgress",
              result: "scanErrors",
              errors: ["A valve scan is already running."]
            },
            obj.callback
          );
        }
        return;
      }
      this.isScanning = true;
      try {
        await this.handleScanValves(obj);
      } finally {
        this.isScanning = false;
      }
      return;
    }
    if (obj.command === "deleteAllValves") {
      const count = this.config2.valves.length;
      this.log.info(`Deleting all ${count} valve(s) from configuration`);
      if (count > 0) {
        await this.writeValvesToNative([]);
      }
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { native: { valves: [] } }, obj.callback);
      }
      return;
    }
    if (obj.command === "deleteValvesByStateId") {
      const rawStateIds = (_a = obj.message) == null ? void 0 : _a.stateIds;
      const stateIds = Array.isArray(rawStateIds) ? rawStateIds.filter((v) => typeof v === "string") : [];
      const toRemove = new Set(stateIds);
      const before = this.config2.valves.length;
      const remaining = this.config2.valves.filter((v) => !toRemove.has(v.stateId));
      const removedCount = before - remaining.length;
      this.log.info(`Removing ${removedCount} valve(s) by stateId from configuration`);
      if (removedCount > 0) {
        await this.writeValvesToNative(remaining);
      }
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { removedCount }, obj.callback);
      }
      return;
    }
    if (obj.command === "send" && obj.callback) {
      this.sendTo(obj.from, obj.command, "Message received", obj.callback);
    }
    if (obj.command === "listValves" && obj.callback) {
      const options = this.config2.valves.map((v, i) => ({
        label: `[${(0, import_types.formatValveNumber)(i)}] ${v.name || "unnamed"}`,
        value: i
      }));
      this.sendTo(obj.from, obj.command, options, obj.callback);
      return;
    }
    if (obj.command === "listValveEditorValves" && obj.callback) {
      const rawValves = (_b = obj.message) == null ? void 0 : _b.valves;
      this.sendTo(obj.from, obj.command, (0, import_valve_editor.buildValveEditorOptions)(rawValves), obj.callback);
      return;
    }
    if (obj.command === "loadValveEditor" && obj.callback) {
      const message = obj.message;
      const valveId = message == null ? void 0 : message._editValveId;
      if (typeof valveId !== "number" || !Number.isInteger(valveId) || valveId < 0) {
        this.sendTo(obj.from, obj.command, { error: "noValveSelected" }, obj.callback);
        return;
      }
      const fields = (0, import_valve_editor.getValveEditorFields)(message == null ? void 0 : message.valves, valveId);
      if (!fields) {
        this.sendTo(obj.from, obj.command, { error: "valveNotFound" }, obj.callback);
        return;
      }
      this.sendTo(obj.from, obj.command, { native: { _editValveId: valveId, ...fields } }, obj.callback);
      return;
    }
    if (obj.command === "applyValveEditor" && obj.callback) {
      const message = obj.message;
      const result = (0, import_valve_editor.applyValveEditorFields)(message == null ? void 0 : message.valves, message == null ? void 0 : message._editValveId, message);
      if ("error" in result) {
        this.sendTo(obj.from, obj.command, { error: result.error }, obj.callback);
        return;
      }
      const fields = (0, import_valve_editor.getValveEditorFields)(result.valves, message == null ? void 0 : message._editValveId);
      if (!fields) {
        this.sendTo(obj.from, obj.command, { error: "valveNotFound" }, obj.callback);
        return;
      }
      this.sendTo(
        obj.from,
        obj.command,
        {
          native: {
            valves: this.formatValvesForNative(result.valves),
            _editValveId: message == null ? void 0 : message._editValveId,
            ...fields
          }
        },
        obj.callback
      );
      return;
    }
    if (obj.command === "listPlans" && obj.callback) {
      const options = this.config2.plans.map((p, i) => ({
        label: p.name || `Plan ${i}`,
        value: i
      }));
      this.sendTo(obj.from, obj.command, options, obj.callback);
      return;
    }
    if (obj.command === "listDwdStations" && obj.callback) {
      this.sendTo(
        obj.from,
        obj.command,
        [{ label: "Keine Wetterstation", value: "" }, ...import_dwd_poi_stations.DWD_POI_STATIONS],
        obj.callback
      );
      return;
    }
    if (obj.command === "createPlan" && obj.callback) {
      const name = readPlanName(obj.message);
      if (!name) {
        this.sendTo(obj.from, obj.command, { error: "noName" }, obj.callback);
        return;
      }
      if (this.config2.plans.some((plan) => plan.name === name)) {
        this.sendTo(obj.from, obj.command, { error: "nameExists" }, obj.callback);
        return;
      }
      const updatedPlans = [...this.config2.plans, { name, valveIndexes: [] }];
      const newPlanIndex = updatedPlans.length - 1;
      await this.writePlansState(updatedPlans);
      this.log.info(`Created new plan "${name}"`);
      this.sendTo(
        obj.from,
        obj.command,
        { native: { plans: updatedPlans, _editPlan: newPlanIndex } },
        obj.callback
      );
      return;
    }
    if (obj.command === "renamePlan" && obj.callback) {
      const planIndex = readPlanIndex(obj.message);
      const name = readPlanName(obj.message);
      if (planIndex === void 0 || planIndex < 0 || planIndex >= this.config2.plans.length) {
        this.sendTo(obj.from, obj.command, { error: "noSelection" }, obj.callback);
        return;
      }
      if (!name) {
        this.sendTo(obj.from, obj.command, { error: "noName" }, obj.callback);
        return;
      }
      if (this.config2.plans.some((plan, index) => index !== planIndex && plan.name === name)) {
        this.sendTo(obj.from, obj.command, { error: "nameExists" }, obj.callback);
        return;
      }
      const oldName = this.config2.plans[planIndex].name;
      const updatedPlans = this.config2.plans.map(
        (plan, index) => index === planIndex ? { ...plan, name } : plan
      );
      await this.writePlansState(updatedPlans);
      const selectedPlan = await this.getStateAsync("automation.planSelect");
      if ((selectedPlan == null ? void 0 : selectedPlan.val) === oldName) {
        await this.setStateAsync("automation.planSelect", { val: name, ack: true });
      }
      this.log.info(`Renamed plan "${oldName}" to "${name}"`);
      this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans, _editPlan: planIndex } }, obj.callback);
      return;
    }
    if (obj.command === "deletePlan" && obj.callback) {
      const planIndex = readPlanIndex(obj.message);
      if (planIndex === void 0 || planIndex < 0 || planIndex >= this.config2.plans.length) {
        this.sendTo(obj.from, obj.command, { error: "noSelection" }, obj.callback);
        return;
      }
      if (this.config2.plans.length <= 1) {
        this.sendTo(obj.from, obj.command, { error: "lastPlan" }, obj.callback);
        return;
      }
      const removedName = this.config2.plans[planIndex].name;
      const updatedPlans = this.config2.plans.filter((_, i) => i !== planIndex);
      const nextSelectedIndex = Math.min(planIndex, updatedPlans.length - 1);
      await this.writePlansState(updatedPlans);
      this.log.info(`Deleted plan "${removedName}"`);
      this.sendTo(
        obj.from,
        obj.command,
        { native: { plans: updatedPlans, _editPlan: nextSelectedIndex } },
        obj.callback
      );
      return;
    }
    if (obj.command === "loadPlanValveTable" && obj.callback) {
      const planIndex = readPlanIndex(obj.message);
      this.sendTo(
        obj.from,
        obj.command,
        { native: { planValveTable: this.getPlanValveTable(planIndex) } },
        obj.callback
      );
      return;
    }
    if (obj.command === "applyPlanValveTable" && obj.callback) {
      const msg = obj.message;
      const planIndex = readPlanIndex(msg);
      if (planIndex === void 0 || planIndex < 0 || planIndex >= this.config2.plans.length) {
        this.sendTo(obj.from, obj.command, { error: "noSelection" }, obj.callback);
        return;
      }
      const rawRows = msg == null ? void 0 : msg.planValveTable;
      const rows = Array.isArray(rawRows) ? rawRows : [];
      const selectedIndexes = (0, import_types.parsePlanValveTableRows)(rows, this.config2.valves);
      const updatedPlans = this.config2.plans.map(
        (p, i) => i === planIndex ? {
          ...p,
          valveIndexes: selectedIndexes.length > 0 ? selectedIndexes : [import_types.NONE_SENTINEL],
          valveStateIds: selectedIndexes.map((index) => this.config2.valves[index].stateId),
          knownValveStateIds: this.config2.valves.map((valve) => valve.stateId)
        } : p
      );
      await this.writePlansState(updatedPlans);
      this.sendTo(
        obj.from,
        obj.command,
        { native: { plans: updatedPlans, planValveTable: this.getPlanValveTable(planIndex) } },
        obj.callback
      );
      return;
    }
    if (obj.command === "addAllValvesToAllPlans" && obj.callback) {
      const allValveIndexes = this.config2.valves.map((_, i) => i);
      const updatedPlans = this.config2.plans.map((p) => ({
        ...p,
        valveIndexes: [...allValveIndexes],
        valveStateIds: this.config2.valves.map((valve) => valve.stateId),
        knownValveStateIds: this.config2.valves.map((valve) => valve.stateId)
      }));
      await this.writePlansState(updatedPlans);
      this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
      return;
    }
    if (obj.command === "removeAllValvesFromAllPlans" && obj.callback) {
      const updatedPlans = this.config2.plans.map((p) => ({
        ...p,
        valveIndexes: [import_types.NONE_SENTINEL],
        valveStateIds: [],
        knownValveStateIds: this.config2.valves.map((valve) => valve.stateId)
      }));
      await this.writePlansState(updatedPlans);
      this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
      return;
    }
  }
  /**
   * Runs the actual valve scan for the `scanValves` message command. Split
   * out of handleMessage() so the isScanning guard there stays simple.
   * Bounded by a timeout so a hung foreign adapter/API can never leave
   * isScanning stuck forever (see the caller in handleMessage()).
   *
   * @param obj
   */
  async handleScanValves(obj) {
    var _a, _b, _c;
    const payload = obj.message;
    let effectiveInstance;
    switch (payload.type) {
      case "All":
        effectiveInstance = "";
        break;
      case "Homematic":
        effectiveInstance = (_a = payload.instanceHomematic) != null ? _a : "";
        break;
      case "Rainbird":
        effectiveInstance = (_b = payload.instanceRainbird) != null ? _b : "";
        break;
      case "Hydrawise":
        effectiveInstance = (_c = payload.instanceHydrawise) != null ? _c : "";
        break;
      default:
        effectiveInstance = payload.instance;
        break;
    }
    const setProgress = (message) => {
      if (this.scanProgressClearTimer) {
        this.clearTimeout(this.scanProgressClearTimer);
        this.scanProgressClearTimer = void 0;
      }
      this.setState("scan.progress", { val: message, ack: true }).catch(() => {
      });
    };
    const finishProgress = (message) => {
      setProgress(message);
      this.scanProgressClearTimer = this.setTimeout(() => {
        this.scanProgressClearTimer = void 0;
        this.setState("scan.progress", { val: "", ack: true }).catch(() => {
        });
      }, 1e4);
    };
    setProgress(`Scanning ${payload.type}...`);
    const SCAN_TIMEOUT_MS = 6e4;
    let result;
    try {
      result = await Promise.race([
        (0, import_valvescanner.scanForValves)(this, payload.type, effectiveInstance, payload.locationId, setProgress),
        new Promise((_resolve, reject) => {
          this.setTimeout(
            () => reject(new Error(`Valve scan timed out after ${SCAN_TIMEOUT_MS / 1e3}s`)),
            SCAN_TIMEOUT_MS
          );
        })
      ]);
    } catch (error) {
      const message = error.message;
      this.log.error(`Valve scan (${payload.type}) failed: ${message}`);
      finishProgress(`Scan failed: ${message}`);
      if (obj.callback) {
        this.sendTo(
          obj.from,
          obj.command,
          { error: "scanFailed", result: "scanErrors", errors: [message] },
          obj.callback
        );
      }
      return;
    }
    const scannedValvesByStateId = new Map(result.valves.map((valve) => [valve.stateId, valve]));
    const existingStateIds = new Set(this.config2.valves.map((valve) => valve.stateId));
    const newValves = result.valves.filter((valve) => !existingStateIds.has(valve.stateId));
    let updatedNames = 0;
    let nextId = this.config2.nextValveId;
    const mergedValves = [...this.config2.valves, ...newValves.map((valve) => ({ ...valve, id: nextId++ }))].map(
      (valve, index) => {
        var _a2;
        const scannedValve = scannedValvesByStateId.get(valve.stateId);
        const name = (scannedValve == null ? void 0 : scannedValve.name) || valve.name;
        if (index < this.config2.valves.length && name !== valve.name) {
          updatedNames++;
        }
        return {
          ...valve,
          name,
          valveNumber: `valve_${(0, import_types.formatValveNumber)((_a2 = valve.id) != null ? _a2 : index)}`
        };
      }
    );
    this.log.info(
      `Valve scan (${payload.type}): found ${result.valves.length}, added ${newValves.length} new, updated ${updatedNames} name(s), ${result.errors.length} error(s)`
    );
    if (newValves.length > 0 || updatedNames > 0) {
      await this.writeNativeAsync({
        valves: this.formatValvesForNative(mergedValves),
        nextValveId: nextId
      });
    }
    const doneMessage = result.errors.length > 0 ? `Scan finished with errors: ${result.errors.join("; ")}` : newValves.length > 0 ? `Found and added ${newValves.length} new valve(s).` : updatedNames > 0 ? `Updated ${updatedNames} valve name(s).` : "Scan finished, no new valves found.";
    finishProgress(doneMessage);
    if (obj.callback) {
      this.sendTo(
        obj.from,
        obj.command,
        {
          found: result.valves.length,
          new: newValves.length,
          errors: result.errors,
          // useNative (without saveConfig) merges the updated valves array into
          // the currently open settings dialog's form state and forces a
          // targeted re-render of the table, without triggering the "Save
          // configuration?" dialog (that is only triggered by saveConfig: true,
          // which we deliberately omit since persistence already happened above
          // via writeValvesToNative/setForeignObjectAsync).
          native: { valves: this.formatValvesForNative(mergedValves) },
          result: result.errors.length > 0 ? "scanErrors" : "scanDone",
          error: void 0,
          args: [String(newValves.length), String(result.valves.length)]
        },
        obj.callback
      );
    }
    return;
  }
}
if (require.main !== module) {
  module.exports = (options) => new Irrigation(options);
} else {
  (() => new Irrigation())();
}
//# sourceMappingURL=main.js.map
