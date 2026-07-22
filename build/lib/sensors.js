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
class SensorManager {
  deps;
  rainState = false;
  soilMoistureState = 0;
  temperatureState = 0;
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
  }
  async onForeignStateChange(id, state) {
    const config = this.deps.getConfig();
    if (id === config.sensors.rainId) {
      this.rainState = (state == null ? void 0 : state.val) === true;
      await this.deps.adapter.setStateAsync("sensors.rain", { val: this.rainState, ack: true });
      return true;
    }
    if (id === config.sensors.soilMoistureId) {
      this.soilMoistureState = typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
      await this.deps.adapter.setStateAsync("sensors.soilMoisture", { val: this.soilMoistureState, ack: true });
      return true;
    }
    if (id === config.sensors.temperatureId) {
      this.temperatureState = typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
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
