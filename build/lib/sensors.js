"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var sensors_exports = {};
__export(sensors_exports, {
  SensorManager: () => SensorManager,
  evaluateRainPause: () => evaluateRainPause
});
module.exports = __toCommonJS(sensors_exports);
var import_hysteresis = require("./hysteresis");
const MAX_SENSOR_AGE_MS = 2 * 60 * 60 * 1e3;
const RAIN_CHECK_INTERVAL_MS = 3e4;
function evaluateRainPause(params) {
  const { raining, belowSinceMs, nowMs, hysteresisMs } = params;
  return (0, import_hysteresis.evaluateHysteresisPause)({ overLimit: raining, belowSinceMs, nowMs, hysteresisMs });
}
class SensorManager {
  deps;
  rainState = false;
  soilMoistureState = 0;
  temperatureState = 0;
  rainStateTs;
  soilMoistureTs;
  soilMoistureValues = /* @__PURE__ */ new Map();
  temperatureTs;
  subscribedIds = [];
  /** Debounced/hysteresis-applied pause decision last reported via onRainChange(), see evaluateRainPause(). */
  rainPaused = false;
  rainBelowSinceMs = null;
  /** Periodic re-evaluation so the resume hysteresis elapses even without a new rain-sensor event. */
  rainCheckTimer;
  constructor(deps) {
    this.deps = deps;
  }
  async init() {
    await this.resubscribe();
    this.rainCheckTimer = this.deps.adapter.setInterval(() => {
      this.evaluateRainPause().catch(
        (error) => this.deps.adapter.log.error(`Rain pause check failed: ${error.message}`)
      );
    }, RAIN_CHECK_INTERVAL_MS);
    await this.evaluateRainPause();
  }
  async resubscribe() {
    for (const id of this.subscribedIds) {
      await this.deps.adapter.unsubscribeForeignStatesAsync(id);
    }
    this.subscribedIds = [];
    const config = this.deps.getConfig();
    const soilMoistureIds = new Set(
      [config.sensors.soilMoistureId, ...config.valves.map((valve) => {
        var _a;
        return (_a = valve.soilMoistureId) != null ? _a : "";
      })].filter(Boolean)
    );
    const stateIds = /* @__PURE__ */ new Set([
      config.sensors.rainId,
      ...soilMoistureIds,
      config.sensors.temperatureId,
      config.legalRestriction.temperatureStateId
    ]);
    for (const id of stateIds) {
      if (id) {
        await this.deps.adapter.subscribeForeignStatesAsync(id);
        this.subscribedIds.push(id);
      }
    }
    if (config.sensors.rainId) {
      const state = await this.deps.adapter.getForeignStateAsync(config.sensors.rainId);
      if (typeof (state == null ? void 0 : state.val) === "boolean") {
        this.rainState = state.val;
        this.rainStateTs = typeof state.ts === "number" ? state.ts : Date.now();
        await this.deps.adapter.setStateAsync("sensors.rain", { val: this.rainState, ack: true });
      }
    }
    this.soilMoistureValues.clear();
    for (const id of soilMoistureIds) {
      const state = await this.deps.adapter.getForeignStateAsync(id);
      if (typeof (state == null ? void 0 : state.val) !== "number" || !Number.isFinite(state.val)) {
        continue;
      }
      const ts = typeof state.ts === "number" ? state.ts : Date.now();
      this.soilMoistureValues.set(id, { value: state.val, ts });
      if (id === config.sensors.soilMoistureId) {
        this.soilMoistureState = state.val;
        this.soilMoistureTs = ts;
        await this.deps.adapter.setStateAsync("sensors.soilMoisture", {
          val: this.soilMoistureState,
          ack: true
        });
      }
    }
    if (config.sensors.temperatureId) {
      const state = await this.deps.adapter.getForeignStateAsync(config.sensors.temperatureId);
      if (typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val)) {
        this.temperatureState = state.val;
        this.temperatureTs = typeof state.ts === "number" ? state.ts : Date.now();
        await this.deps.adapter.setStateAsync("sensors.temperature", {
          val: this.temperatureState,
          ack: true
        });
      }
    }
  }
  async onForeignStateChange(id, state) {
    const config = this.deps.getConfig();
    if (id === config.sensors.rainId) {
      if (typeof (state == null ? void 0 : state.val) === "boolean") {
        this.rainState = state.val;
      } else {
        this.deps.adapter.log.warn(
          `Rain sensor state ${id} has no valid boolean value; keeping previous value (${this.rainState}).`
        );
      }
      this.rainStateTs = Date.now();
      await this.deps.adapter.setStateAsync("sensors.rain", { val: this.rainState, ack: true });
      await this.evaluateRainPause();
      return true;
    }
    const isGlobalSoilMoistureSensor = id === config.sensors.soilMoistureId;
    const isValveSoilMoistureSensor = config.valves.some((valve) => valve.soilMoistureId === id);
    if (isGlobalSoilMoistureSensor || isValveSoilMoistureSensor) {
      if (typeof (state == null ? void 0 : state.val) !== "number" || !Number.isFinite(state.val)) {
        this.deps.adapter.log.warn(
          `Soil moisture sensor state ${id} has no valid numeric value; keeping previous value.`
        );
        return true;
      }
      const ts = typeof state.ts === "number" ? state.ts : Date.now();
      this.soilMoistureValues.set(id, { value: state.val, ts });
      if (isGlobalSoilMoistureSensor) {
        this.soilMoistureState = state.val;
        this.soilMoistureTs = ts;
        await this.deps.adapter.setStateAsync("sensors.soilMoisture", {
          val: this.soilMoistureState,
          ack: true
        });
      }
      return true;
    }
    if (id === config.sensors.temperatureId) {
      if (typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val)) {
        this.temperatureState = state.val;
      } else {
        this.deps.adapter.log.warn(
          `Temperature sensor state ${id} has no valid numeric value; keeping previous value (${this.temperatureState}).`
        );
      }
      this.temperatureTs = Date.now();
      await this.deps.adapter.setStateAsync("sensors.temperature", { val: this.temperatureState, ack: true });
      return true;
    }
    return false;
  }
  isRaining() {
    return this.rainState;
  }
  getSoilMoisture() {
    return this.soilMoistureState;
  }
  getTemperature() {
    return this.temperatureState;
  }
  isStale(ts) {
    return ts === void 0 || Date.now() - ts > MAX_SENSOR_AGE_MS;
  }
  async getTemperatureAdjustmentTemperature() {
    const stateId = this.deps.getConfig().scheduler.temperatureAdjustmentStateId;
    if (!stateId) {
      return void 0;
    }
    const state = await this.deps.adapter.getForeignStateAsync(stateId);
    return typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val) ? state.val : void 0;
  }
  /**
   * Called on adapter unload to release the foreign-state subscriptions made
   * in resubscribe()/init(), for consistency with the other subsystems'
   * cleanup discipline (rateLimiter, automation, scheduler, dwd, windMonitor,
   * weatherApi, flowMonitor, valves).
   */
  destroy() {
    if (this.rainCheckTimer) {
      this.deps.adapter.clearInterval(this.rainCheckTimer);
      this.rainCheckTimer = void 0;
    }
    for (const id of this.subscribedIds) {
      this.deps.adapter.unsubscribeForeignStatesAsync(id).catch(() => void 0);
    }
    this.subscribedIds = [];
  }
  /**
   * Applies evaluateRainPause() to the current raw `rainState` and only
   * calls onRainChange() when the debounced decision actually flips - see
   * the evaluateRainPause()/RainPauseState doc comment for why this
   * debouncing is necessary. Run both on every rain-sensor event and
   * periodically (see RAIN_CHECK_INTERVAL_MS) so the hysteresis delay
   * elapses reliably even while no new sensor event arrives.
   */
  async evaluateRainPause() {
    var _a, _b;
    const hysteresisMinutes = this.deps.getConfig().scheduler.rainHysteresisMinutes;
    const result = evaluateRainPause({
      raining: this.rainState,
      belowSinceMs: this.rainBelowSinceMs,
      nowMs: Date.now(),
      hysteresisMs: (0, import_hysteresis.hysteresisMinutesToMs)(hysteresisMinutes)
    });
    this.rainBelowSinceMs = result.belowSinceMs;
    if (result.paused !== this.rainPaused) {
      this.rainPaused = result.paused;
      await ((_b = (_a = this.deps).onRainChange) == null ? void 0 : _b.call(_a, this.rainPaused));
    }
  }
  /**
   * See plan behavior rules "Niederschlagsunabhängigkeit" and "Bodenfeuchte-Schwellwert".
   *
   * @param valveIndex
   */
  isValveBlocked(valveIndex) {
    const config = this.deps.getConfig();
    const valve = config.valves[valveIndex];
    if (!valve) {
      return { blocked: false };
    }
    if (config.sensors.rainId && this.rainState && !valve.rainIndependent) {
      return { blocked: true, reason: "rain detected" };
    }
    if (config.sensors.rainId && !valve.rainIndependent && this.isStale(this.rainStateTs)) {
      this.deps.adapter.log.warn(
        `Rain sensor value is stale (older than ${MAX_SENSOR_AGE_MS / 6e4} minutes); blocking valve as a precaution.`
      );
      return { blocked: true, reason: "rain sensor data is stale" };
    }
    const soilMoisture = valve.soilMoistureId ? this.soilMoistureValues.get(valve.soilMoistureId) : void 0;
    if (soilMoisture && valve.moistureThreshold > 0 && soilMoisture.value >= valve.moistureThreshold) {
      return {
        blocked: true,
        reason: `soil moisture ${soilMoisture.value}% >= threshold ${valve.moistureThreshold}%`
      };
    }
    return { blocked: false };
  }
  /** See plan behavior rule "Frostschutz". */
  isFrostBlocked() {
    const config = this.deps.getConfig();
    if (!config.scheduler.frostEnabled) {
      return false;
    }
    const temp = config.sensors.temperatureId ? this.temperatureState : void 0;
    if (temp === void 0) {
      return false;
    }
    if (config.sensors.temperatureId && this.isStale(this.temperatureTs)) {
      this.deps.adapter.log.warn(
        `Temperature sensor value is stale (older than ${MAX_SENSOR_AGE_MS / 6e4} minutes); assuming frost protection is active as a precaution.`
      );
      return true;
    }
    return temp < config.scheduler.frostMinTemp;
  }
  /** See plan behavior rule "Saison-Pause". */
  isSeasonBlocked() {
    const config = this.deps.getConfig();
    if (!config.scheduler.seasonEnabled) {
      return false;
    }
    const month = (/* @__PURE__ */ new Date()).getMonth() + 1;
    const { seasonStart, seasonEnd } = config.scheduler;
    if (seasonStart <= seasonEnd) {
      return month < seasonStart || month > seasonEnd;
    }
    return month < seasonStart && month > seasonEnd;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SensorManager,
  evaluateRainPause
});
//# sourceMappingURL=sensors.js.map
