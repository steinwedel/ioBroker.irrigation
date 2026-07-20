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
var water_consumption_exports = {};
__export(water_consumption_exports, {
  WaterConsumptionTracker: () => WaterConsumptionTracker
});
module.exports = __toCommonJS(water_consumption_exports);
class WaterConsumptionTracker {
  deps;
  valveStartedAt = /* @__PURE__ */ new Map();
  dayTotal = 0;
  weekTotal = 0;
  monthTotal = 0;
  grandTotal = 0;
  currentDay = (/* @__PURE__ */ new Date()).getDate();
  constructor(deps) {
    this.deps = deps;
  }
  async init() {
    const config = this.deps.getConfig();
    await this.deps.adapter.setStateAsync("waterConsumption.enabled", {
      val: config.waterConsumption.enabled,
      ack: true
    });
    const today = await this.deps.adapter.getStateAsync("waterConsumption.today");
    const week = await this.deps.adapter.getStateAsync("waterConsumption.week");
    const month = await this.deps.adapter.getStateAsync("waterConsumption.month");
    const total = await this.deps.adapter.getStateAsync("waterConsumption.total");
    this.dayTotal = typeof (today == null ? void 0 : today.val) === "number" ? today.val : 0;
    this.weekTotal = typeof (week == null ? void 0 : week.val) === "number" ? week.val : 0;
    this.monthTotal = typeof (month == null ? void 0 : month.val) === "number" ? month.val : 0;
    this.grandTotal = typeof (total == null ? void 0 : total.val) === "number" ? total.val : 0;
  }
  /**
   * Called by automation.ts when a valve opens/closes.
   *
   * @param valveIndex
   * @param flowing
   */
  onValveFlowChange(valveIndex, flowing) {
    var _a;
    if (!this.deps.getConfig().waterConsumption.enabled) {
      return;
    }
    if (flowing) {
      this.valveStartedAt.set(valveIndex, Date.now());
    } else {
      const startedAt = this.valveStartedAt.get(valveIndex);
      if (startedAt === void 0) {
        return;
      }
      this.valveStartedAt.delete(valveIndex);
      const elapsedMin = (Date.now() - startedAt) / 6e4;
      const config = this.deps.getConfig();
      const valve = config.valves[valveIndex];
      const liters = elapsedMin * ((_a = valve == null ? void 0 : valve.flowRateLpm) != null ? _a : 0);
      this.recordConsumption(valveIndex, liters).catch(
        (error) => this.deps.adapter.log.error(`Failed to record water consumption: ${error.message}`)
      );
    }
  }
  async recordConsumption(valveIndex, liters) {
    this.rolloverIfNeeded();
    this.dayTotal += liters;
    this.weekTotal += liters;
    this.monthTotal += liters;
    this.grandTotal += liters;
    await this.deps.adapter.setStateAsync("waterConsumption.today", { val: round2(this.dayTotal), ack: true });
    await this.deps.adapter.setStateAsync("waterConsumption.week", { val: round2(this.weekTotal), ack: true });
    await this.deps.adapter.setStateAsync("waterConsumption.month", { val: round2(this.monthTotal), ack: true });
    await this.deps.adapter.setStateAsync("waterConsumption.total", { val: round2(this.grandTotal), ack: true });
  }
  rolloverIfNeeded() {
    const nowDay = (/* @__PURE__ */ new Date()).getDate();
    if (nowDay !== this.currentDay) {
      this.dayTotal = 0;
      this.currentDay = nowDay;
    }
    const now = /* @__PURE__ */ new Date();
    if (now.getDay() === 1) {
      this.weekTotal = 0;
    }
    if (now.getDate() === 1) {
      this.monthTotal = 0;
    }
  }
}
function round2(value) {
  return Math.round(value * 100) / 100;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WaterConsumptionTracker
});
//# sourceMappingURL=water-consumption.js.map
