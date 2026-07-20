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
var import_water_consumption = require("./lib/water-consumption");
var import_weather_api = require("./lib/weather-api");
var import_notifications = require("./lib/notifications");
var import_flow_monitor = require("./lib/flow-monitor");
var import_valvescanner = require("./lib/valvescanner");
var import_rate_limiter = require("./lib/rate-limiter");
function valvesEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  const objA = a;
  const objB = b;
  const keysA = Object.keys(objA).filter((key) => objA[key] !== void 0);
  const keysB = Object.keys(objB).filter((key) => objB[key] !== void 0);
  if (keysA.length !== keysB.length) {
    return false;
  }
  return keysA.every((key) => objA[key] === objB[key]);
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
    await (0, import_states.applyConfigToStates)(this, this.config2);
    this.rateLimiter = new import_rate_limiter.RateLimiter();
    await this.createRateLimitStates();
    this.valves = this.config2.valves.map(
      (valveConfig, index) => new import_ventile.ValveController(this, index, valveConfig, this.rateLimiter)
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
    this.subscribeStates("watchdog.testNotify");
    this.subscribeStates("valves.*.state");
    this.subscribeStates("valves.*.runFor");
    await this.setStateAsync("info.connection", { val: true, ack: true });
    this.rateLimiterPoll = this.setInterval(() => this.updateRateLimitStates(), 1e4);
  }
  /**
   * Persists newly introduced/normalized config fields (e.g. IValveConfig.runFor)
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
    const needsValveMigration = rawValves.length !== migratedValves.length || rawValves.some((raw, i) => !valvesEqual(raw, migratedValves[i]));
    if (needsValveMigration) {
      this.log.info("Migrating native.valves to include newly introduced fields (runFor, valveNumber).");
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
        native: { valves: migratedValves }
      });
    }
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
    var _a, _b, _c, _d, _e;
    try {
      if (this.rateLimiterPoll) {
        this.clearInterval(this.rateLimiterPoll);
        this.rateLimiterPoll = void 0;
      }
      (_a = this.automation) == null ? void 0 : _a.destroy();
      (_b = this.scheduler) == null ? void 0 : _b.destroy();
      (_c = this.dwd) == null ? void 0 : _c.destroy();
      (_d = this.weatherApi) == null ? void 0 : _d.destroy();
      (_e = this.flowMonitor) == null ? void 0 : _e.destroy();
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
      if (await this.sensorManager.onForeignStateChange(id, state)) {
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
   * Writes `native.valves` directly to our own instance object instead of returning
   * `{native, saveConfig: true}` via a sendTo response, which would pop up an extra
   * "Save configuration?" confirmation dialog in the admin UI. Writing the object
   * directly persists it immediately and triggers the usual adapter restart, without
   * that extra dialog.
   *
   * Uses a full setForeignObjectAsync (read-modify-write) rather than
   * extendForeignObjectAsync: extendObject's underlying deep-merge (node.extend)
   * treats arrays as index-keyed maps, so merging a shorter (or empty) array into an
   * existing longer array does not fully replace it - some stale elements would
   * survive. A full read-modify-write always replaces the array outright.
   *
   * @param valves
   */
  async writeValvesToNative(valves) {
    var _a;
    const instanceObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
    if (instanceObj) {
      instanceObj.native = (_a = instanceObj.native) != null ? _a : {};
      instanceObj.native.valves = valves;
      await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instanceObj);
    }
  }
  async onMessage(obj) {
    var _a, _b;
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
      const existingStateIds = new Set(this.config2.valves.map((v) => v.stateId));
      const newValves = result.valves.filter((v) => !existingStateIds.has(v.stateId));
      const mergedValves = [...this.config2.valves, ...newValves].map((valve, index) => ({
        ...valve,
        valveNumber: `valve_${(0, import_types.formatValveNumber)(index)}`
      }));
      this.log.info(
        `Valve scan (${payload.type}): found ${result.valves.length}, added ${newValves.length} new, ${result.errors.length} error(s)`
      );
      if (newValves.length > 0) {
        await this.writeValvesToNative(mergedValves);
      }
      const doneMessage = result.errors.length > 0 ? `Scan finished with errors: ${result.errors.join("; ")}` : newValves.length > 0 ? `Found and added ${newValves.length} new valve(s).` : "Scan finished, no new valves found.";
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
    if (obj.command === "send" && obj.callback) {
      this.sendTo(obj.from, obj.command, "Message received", obj.callback);
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Irrigation(options);
} else {
  (() => new Irrigation())();
}
//# sourceMappingURL=main.js.map
