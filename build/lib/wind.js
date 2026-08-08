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
var wind_exports = {};
__export(wind_exports, {
  WindMonitor: () => WindMonitor,
  evaluateWindPause: () => evaluateWindPause
});
module.exports = __toCommonJS(wind_exports);
var import_hysteresis = require("./hysteresis");
function evaluateWindPause(params) {
  const { speed, gust, speedLimit, gustLimit, belowSinceMs, nowMs, hysteresisMs } = params;
  const overLimit = speedLimit > 0 && speed !== void 0 && speed >= speedLimit || gustLimit > 0 && gust !== void 0 && gust >= gustLimit;
  return (0, import_hysteresis.evaluateHysteresisPause)({ overLimit, belowSinceMs, nowMs, hysteresisMs });
}
class WindMonitor {
  deps;
  speed;
  gust;
  belowSinceMs = null;
  paused = false;
  checkTimer;
  subscribedIds = [];
  constructor(deps) {
    this.deps = deps;
  }
  isOverLimit() {
    return this.paused;
  }
  async init() {
    await this.resubscribe();
    this.checkTimer = this.deps.adapter.setInterval(() => {
      this.evaluate().catch(
        (error) => this.deps.adapter.log.error(`Wind pause check failed: ${error.message}`)
      );
    }, 3e4);
    await this.evaluate();
  }
  destroy() {
    if (this.checkTimer) {
      this.deps.adapter.clearInterval(this.checkTimer);
      this.checkTimer = void 0;
    }
  }
  async resubscribe() {
    for (const id of this.subscribedIds) {
      await this.deps.adapter.unsubscribeForeignStatesAsync(id);
    }
    this.subscribedIds = [];
    this.speed = void 0;
    this.gust = void 0;
    const config = this.deps.getConfig().scheduler;
    for (const id of /* @__PURE__ */ new Set([config.windSpeedStateId, config.windGustStateId])) {
      if (id) {
        await this.deps.adapter.subscribeForeignStatesAsync(id);
        this.subscribedIds.push(id);
      }
    }
    if (config.windSpeedStateId) {
      const state = await this.deps.adapter.getForeignStateAsync(config.windSpeedStateId);
      this.speed = typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val) ? state.val : void 0;
    }
    if (config.windGustStateId) {
      const state = await this.deps.adapter.getForeignStateAsync(config.windGustStateId);
      this.gust = typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val) ? state.val : void 0;
    }
  }
  async onForeignStateChange(id, state) {
    const config = this.deps.getConfig().scheduler;
    if (id === config.windSpeedStateId) {
      this.speed = typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val) ? state.val : void 0;
    } else if (id === config.windGustStateId) {
      this.gust = typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val) ? state.val : void 0;
    } else {
      return false;
    }
    await this.evaluate();
    return true;
  }
  async evaluate() {
    const config = this.deps.getConfig().scheduler;
    if (!config.windPauseEnabled) {
      return;
    }
    const result = evaluateWindPause({
      speed: this.speed,
      gust: this.gust,
      speedLimit: config.windSpeedLimit,
      gustLimit: config.windGustLimit,
      belowSinceMs: this.belowSinceMs,
      nowMs: Date.now(),
      hysteresisMs: (0, import_hysteresis.hysteresisMinutesToMs)(config.windHysteresisMinutes)
    });
    this.belowSinceMs = result.belowSinceMs;
    if (result.paused !== this.paused) {
      this.paused = result.paused;
      await this.deps.onWindPauseChange(this.paused);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WindMonitor,
  evaluateWindPause
});
//# sourceMappingURL=wind.js.map
