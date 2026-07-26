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
  SensorManager: () => SensorManager
});
module.exports = __toCommonJS(sensors_exports);
const MAX_SENSOR_AGE_MS = 2 * 60 * 60 * 1e3;
class SensorManager {
  deps;
  rainState = false;
  soilMoistureState = 0;
  temperatureState = 0;
  rainStateTs;
  soilMoistureTs;
  temperatureTs;
  subscribedIds = [];
  constructor(deps) {
    this.deps = deps;
  }
  async init() {
    await this.resubscribe();
  }
  async resubscribe() {
    for (const id of this.subscribedIds) {
      await this.deps.adapter.unsubscribeForeignStatesAsync(id);
    }
    this.subscribedIds = [];
    const config = this.deps.getConfig();
    const stateIds = /* @__PURE__ */ new Set([
      config.sensors.rainId,
      config.sensors.soilMoistureId,
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
    if (config.sensors.soilMoistureId) {
      const state = await this.deps.adapter.getForeignStateAsync(config.sensors.soilMoistureId);
      if (typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val)) {
        this.soilMoistureState = state.val;
        this.soilMoistureTs = typeof state.ts === "number" ? state.ts : Date.now();
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
    var _a, _b;
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
      await ((_b = (_a = this.deps).onRainChange) == null ? void 0 : _b.call(_a, this.rainState));
      return true;
    }
    if (id === config.sensors.soilMoistureId) {
      if (typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val)) {
        this.soilMoistureState = state.val;
      } else {
        this.deps.adapter.log.warn(
          `Soil moisture sensor state ${id} has no valid numeric value; keeping previous value (${this.soilMoistureState}).`
        );
      }
      this.soilMoistureTs = Date.now();
      await this.deps.adapter.setStateAsync("sensors.soilMoisture", { val: this.soilMoistureState, ack: true });
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
    for (const id of this.subscribedIds) {
      this.deps.adapter.unsubscribeForeignStatesAsync(id).catch(() => void 0);
    }
    this.subscribedIds = [];
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
    if (config.sensors.soilMoistureId && valve.moistureThreshold > 0 && this.soilMoistureState >= valve.moistureThreshold) {
      return {
        blocked: true,
        reason: `soil moisture ${this.soilMoistureState}% >= threshold ${valve.moistureThreshold}%`
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
  SensorManager
});
//# sourceMappingURL=sensors.js.map
