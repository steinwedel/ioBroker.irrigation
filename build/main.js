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
var import_types = require("./lib/types");
var import_states = require("./lib/states");
var import_ventile = require("./lib/ventile");
var import_automation = require("./lib/automation");
var import_scheduler = require("./lib/scheduler");
var import_sensors = require("./lib/sensors");
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
class Irrigation extends utils.Adapter {
  config2;
  valves = [];
  automation;
  scheduler;
  sensorManager;
  dwd;
  waterConsumption;
  weatherApi;
  notifications;
  flowMonitor;
  rateLimiter;
  rateLimiterPoll;
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
      (valveConfig, index) => new import_ventile.ValveController(this, index, valveConfig, this.rateLimiter, () => this.valves)
    );
    for (const valve of this.valves) {
      await valve.init();
    }
    this.notifications = new import_notifications.NotificationManager({ adapter: this, getConfig: () => this.config2 });
    this.sensorManager = new import_sensors.SensorManager({ adapter: this, getConfig: () => this.config2 });
    await this.sensorManager.init();
    this.waterConsumption = new import_water_consumption.WaterConsumptionTracker({ adapter: this, getConfig: () => this.config2 });
    await this.waterConsumption.init();
    this.flowMonitor = new import_flow_monitor.FlowMonitor({
      adapter: this,
      getConfig: () => this.config2,
      notifications: this.notifications,
      isAnyValveRunning: () => this.valves.some((v) => v.isRunning())
    });
    await this.flowMonitor.init();
    this.automation = new import_automation.AutomationEngine({
      adapter: this,
      getConfig: () => this.config2,
      valves: this.valves,
      isValveBlockedForAutoRun: (valveIndex) => this.sensorManager.isValveBlocked(valveIndex),
      isLegallyRestricted: () => this.dwd.isActive(),
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
   */
  async migrateNativeConfig() {
    var _a;
    const rawValves = (_a = this.config.valves) != null ? _a : [];
    const migratedValves = this.config2.valves.map((valve, index) => ({
      ...valve,
      valveNumber: `valve_${(0, import_types.formatValveNumber)(index)}`
    }));
    const needsValveMigration = rawValves.length !== migratedValves.length || rawValves.some((raw) => !raw.valveNumber || "runFor" in raw);
    if (needsValveMigration) {
      this.log.info("Migrating native.valves to remove runFor and include valveNumber.");
      await this.writeNativeAsync({ valves: migratedValves });
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
      if (JSON.stringify(synchronizedPlans) !== JSON.stringify(storedPlans)) {
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
          valveOrder: Array.isArray(p == null ? void 0 : p.valveOrder) ? p.valveOrder : void 0,
          valveStateIds: Array.isArray(p == null ? void 0 : p.valveStateIds) ? p.valveStateIds : void 0,
          valveOrderStateIds: Array.isArray(p == null ? void 0 : p.valveOrderStateIds) ? p.valveOrderStateIds : void 0,
          knownValveStateIds: Array.isArray(p == null ? void 0 : p.knownValveStateIds) ? p.knownValveStateIds : void 0
        };
      });
    } catch (err) {
      this.log.warn(`Failed to parse automation.plansData state, ignoring: ${err.message}`);
      return void 0;
    }
  }
  synchronizePlansWithValves(plans) {
    const currentStateIds = this.config2.valves.map((valve) => valve.stateId);
    return plans.map((plan) => {
      var _a, _b, _c, _d;
      const explicitlyEmpty = plan.valveIndexes.includes(import_types.NONE_SENTINEL);
      const legacySelectedStateIds = plan.valveIndexes.map((index) => currentStateIds[index]).filter((stateId) => Boolean(stateId));
      const selectedStateIds = [
        ...(_a = plan.valveStateIds) != null ? _a : plan.valveIndexes.length === 0 ? currentStateIds : legacySelectedStateIds
      ].filter((stateId) => currentStateIds.includes(stateId));
      const knownStateIds = (_b = plan.knownValveStateIds) != null ? _b : currentStateIds;
      if (!explicitlyEmpty) {
        for (const stateId of currentStateIds) {
          if (!knownStateIds.includes(stateId) && !selectedStateIds.includes(stateId)) {
            selectedStateIds.push(stateId);
          }
        }
      }
      const legacyOrderStateIds = ((_c = plan.valveOrder) != null ? _c : []).map((index) => currentStateIds[index]).filter((stateId) => Boolean(stateId));
      const orderStateIds = [
        ...(_d = plan.valveOrderStateIds) != null ? _d : legacyOrderStateIds
      ].filter((stateId) => selectedStateIds.includes(stateId));
      for (const stateId of selectedStateIds) {
        if (!orderStateIds.includes(stateId)) {
          orderStateIds.push(stateId);
        }
      }
      const valveIndexes = selectedStateIds.map((stateId) => currentStateIds.indexOf(stateId));
      const valveOrder = orderStateIds.map((stateId) => currentStateIds.indexOf(stateId));
      return {
        ...plan,
        valveIndexes: explicitlyEmpty ? [import_types.NONE_SENTINEL] : valveIndexes,
        valveOrder,
        valveStateIds: selectedStateIds,
        valveOrderStateIds: orderStateIds,
        knownValveStateIds: currentStateIds
      };
    });
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
    await this.setStateAsync("automation.plansData", { val: JSON.stringify(synchronizedPlans), ack: true });
    await this.publishPlanNames(synchronizedPlans);
  }
  async publishPlanNames(plans) {
    const planNames = plans.map((plan) => plan.name);
    const states = Object.fromEntries(planNames.map((planName) => [planName, planName]));
    await this.setStateAsync("automation.plansList", { val: JSON.stringify(planNames), ack: true });
    await this.extendObjectAsync("automation.planSelect", { common: { states } });
    await this.extendObjectAsync("automation.startPlan", { common: { states } });
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
          (_b = (_a = this.config2.plans[0]) == null ? void 0 : _a.name) != null ? _b : "Alle"
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
  onUnload(callback) {
    var _a, _b, _c, _d, _e, _f;
    try {
      if (this.rateLimiterPoll) {
        this.clearInterval(this.rateLimiterPoll);
        this.rateLimiterPoll = void 0;
      }
      (_a = this.rateLimiter) == null ? void 0 : _a.destroy();
      (_b = this.automation) == null ? void 0 : _b.destroy();
      (_c = this.scheduler) == null ? void 0 : _c.destroy();
      (_d = this.dwd) == null ? void 0 : _d.destroy();
      (_e = this.weatherApi) == null ? void 0 : _e.destroy();
      (_f = this.flowMonitor) == null ? void 0 : _f.destroy();
      for (const valve of this.valves) {
        valve.destroy();
      }
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
  async onStateChange(id, state) {
    var _a, _b;
    if (!state) {
      return;
    }
    if (!id.startsWith(`${this.namespace}.`)) {
      for (const valve of this.valves) {
        if (await valve.onForeignStateChange(id, state)) {
          return;
        }
      }
      const handledBySensor = await this.sensorManager.onForeignStateChange(id, state);
      const handledByRestriction = await this.dwd.onForeignStateChange(id, state);
      if (handledBySensor || handledByRestriction) {
        return;
      }
      if (await this.scheduler.onForeignStateChange(id, state)) {
        return;
      }
      if (await this.flowMonitor.onForeignStateChange(id, state)) {
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
        await this.automation.requestRun((_b = (_a = this.config2.plans[0]) == null ? void 0 : _a.name) != null ? _b : "Alle", "manual-button");
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
      const valveIndex = parseInt(valveManualStartMatch[1], 10);
      await this.automation.manualStartValve(valveIndex);
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
  async writeValvesToNative(valves) {
    await this.writeNativeAsync({ valves });
  }
  getPlanValveIndexes(planIndex) {
    var _a;
    const plan = planIndex !== void 0 && planIndex >= 0 && planIndex < this.config2.plans.length ? this.config2.plans[planIndex] : void 0;
    const allValveIndexes = this.config2.valves.map((_, index) => index);
    return plan && plan.valveIndexes.length === 0 ? allValveIndexes : ((_a = plan == null ? void 0 : plan.valveIndexes) != null ? _a : []).filter((index) => index >= 0 && index < this.config2.valves.length);
  }
  getPlanValveTable(planIndex) {
    var _a;
    const allValveIndexes = this.config2.valves.map((_, index) => index);
    const assignedIndexes = this.getPlanValveIndexes(planIndex);
    const assignedSet = new Set(assignedIndexes);
    const plan = planIndex !== void 0 && planIndex >= 0 && planIndex < this.config2.plans.length ? this.config2.plans[planIndex] : void 0;
    const storedOrder = ((_a = plan == null ? void 0 : plan.valveOrder) != null ? _a : []).filter((index) => allValveIndexes.includes(index));
    const orderedIndexes = [...storedOrder, ...allValveIndexes.filter((index) => !storedOrder.includes(index))];
    return orderedIndexes.map((index) => ({
      valveNumber: (0, import_types.formatValveNumber)(index),
      name: this.config2.valves[index].name || "unnamed",
      assigned: assignedSet.has(index)
    }));
  }
  async onMessage(obj) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    if (typeof obj !== "object" || !obj.command) {
      return;
    }
    if (obj.command === "scanValves") {
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
        this.setState("scan.progress", { val: message, ack: true }).catch(() => {
        });
      };
      setProgress(`Scanning ${payload.type}...`);
      const result = await (0, import_valvescanner.scanForValves)(this, payload.type, effectiveInstance, payload.locationId, setProgress);
      const scannedValvesByStateId = new Map(result.valves.map((valve) => [valve.stateId, valve]));
      const existingStateIds = new Set(this.config2.valves.map((valve) => valve.stateId));
      const newValves = result.valves.filter((valve) => !existingStateIds.has(valve.stateId));
      let updatedNames = 0;
      const mergedValves = [...this.config2.valves, ...newValves].map((valve, index) => {
        const scannedValve = scannedValvesByStateId.get(valve.stateId);
        const name = (scannedValve == null ? void 0 : scannedValve.name) || valve.name;
        if (index < this.config2.valves.length && name !== valve.name) {
          updatedNames++;
        }
        return {
          ...valve,
          name,
          valveNumber: `valve_${(0, import_types.formatValveNumber)(index)}`
        };
      });
      this.log.info(
        `Valve scan (${payload.type}): found ${result.valves.length}, added ${newValves.length} new, updated ${updatedNames} name(s), ${result.errors.length} error(s)`
      );
      if (newValves.length > 0 || updatedNames > 0) {
        await this.writeValvesToNative(mergedValves);
      }
      const doneMessage = result.errors.length > 0 ? `Scan finished with errors: ${result.errors.join("; ")}` : newValves.length > 0 ? `Found and added ${newValves.length} new valve(s).` : updatedNames > 0 ? `Updated ${updatedNames} valve name(s).` : "Scan finished, no new valves found.";
      setProgress(doneMessage);
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
            native: { valves: mergedValves },
            result: result.errors.length > 0 ? "scanErrors" : "scanDone",
            error: void 0,
            args: [String(newValves.length), String(result.valves.length)]
          },
          obj.callback
        );
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
      const stateIds = (_e = (_d = obj.message) == null ? void 0 : _d.stateIds) != null ? _e : [];
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
      const name = (_g = (_f = obj.message) == null ? void 0 : _f.planName) == null ? void 0 : _g.trim();
      if (!name) {
        this.sendTo(obj.from, obj.command, { error: "noName" }, obj.callback);
        return;
      }
      const updatedPlans = [...this.config2.plans, { name, valveIndexes: [], valveOrder: [] }];
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
      const name = (_i = (_h = obj.message) == null ? void 0 : _h.planName) == null ? void 0 : _i.trim();
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
        { native: { _planValveTable: this.getPlanValveTable(planIndex) } },
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
      const rows = (_j = msg == null ? void 0 : msg.planValveTable) != null ? _j : [];
      const selectedIndexes = (0, import_types.parsePlanValveTableRows)(rows, this.config2.valves.length);
      const valveOrder = (0, import_types.parsePlanValveTableOrder)(rows, this.config2.valves.length);
      const updatedPlans = this.config2.plans.map(
        (p, i) => i === planIndex ? {
          ...p,
          valveIndexes: selectedIndexes.length > 0 ? selectedIndexes : [import_types.NONE_SENTINEL],
          valveOrder,
          valveStateIds: selectedIndexes.map((index) => this.config2.valves[index].stateId),
          valveOrderStateIds: valveOrder.map((index) => this.config2.valves[index].stateId),
          knownValveStateIds: this.config2.valves.map((valve) => valve.stateId)
        } : p
      );
      await this.writePlansState(updatedPlans);
      this.sendTo(
        obj.from,
        obj.command,
        { native: { plans: updatedPlans, _planValveTable: this.getPlanValveTable(planIndex) } },
        obj.callback
      );
      return;
    }
    if (obj.command === "addAllValvesToAllPlans" && obj.callback) {
      const allValveIndexes = this.config2.valves.map((_, i) => i);
      const updatedPlans = this.config2.plans.map((p) => ({
        ...p,
        valveIndexes: [...allValveIndexes],
        valveOrder: [...allValveIndexes],
        valveStateIds: this.config2.valves.map((valve) => valve.stateId),
        valveOrderStateIds: this.config2.valves.map((valve) => valve.stateId),
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
        valveOrder: [],
        valveStateIds: [],
        valveOrderStateIds: [],
        knownValveStateIds: this.config2.valves.map((valve) => valve.stateId)
      }));
      await this.writePlansState(updatedPlans);
      this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
      return;
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Irrigation(options);
} else {
  (() => new Irrigation())();
}
//# sourceMappingURL=main.js.map
