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
var flow_monitor_exports = {};
__export(flow_monitor_exports, {
  FlowMonitor: () => FlowMonitor
});
module.exports = __toCommonJS(flow_monitor_exports);
var import_types = require("./types");
const DEVIATION_THRESHOLD_PCT = 30;
const CALIBRATION_DURATION_SECS = 120;
class FlowMonitor {
  deps;
  subscribedIds = /* @__PURE__ */ new Map();
  // stateId -> valveIndex
  calibrationSamples = /* @__PURE__ */ new Map();
  calibrationActive = /* @__PURE__ */ new Set();
  calibrationTimers = /* @__PURE__ */ new Map();
  constructor(deps) {
    this.deps = deps;
  }
  async init() {
    await this.resubscribe();
  }
  async resubscribe() {
    for (const id of this.subscribedIds.keys()) {
      await this.deps.adapter.unsubscribeForeignStatesAsync(id);
    }
    this.subscribedIds.clear();
    const config = this.deps.getConfig();
    for (let i = 0; i < config.valves.length; i++) {
      const id = config.valves[i].flowSensorId;
      if (id) {
        await this.deps.adapter.subscribeForeignStatesAsync(id);
        this.subscribedIds.set(id, i);
      }
    }
  }
  async onForeignStateChange(id, state) {
    var _a;
    const valveIndex = this.subscribedIds.get(id);
    if (valveIndex === void 0) {
      return false;
    }
    const flow = typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
    await this.deps.adapter.setStateAsync(`valves.valve_${(0, import_types.formatValveNumber)(valveIndex)}.flowActual`, {
      val: flow,
      ack: true
    });
    if (this.calibrationActive.has(valveIndex)) {
      const samples = (_a = this.calibrationSamples.get(valveIndex)) != null ? _a : [];
      samples.push(flow);
      this.calibrationSamples.set(valveIndex, samples);
    } else {
      await this.checkDeviation(valveIndex, flow);
    }
    if (!this.deps.isAnyValveRunning() && flow > 0) {
      await this.reportLeak(valveIndex, flow);
    }
    return true;
  }
  async checkDeviation(valveIndex, actualFlow) {
    var _a, _b;
    const expected = await this.getExpectedFlow(valveIndex);
    if (!expected || expected <= 0) {
      return;
    }
    const deviationPct = (actualFlow - expected) / expected * 100;
    if (Math.abs(deviationPct) > DEVIATION_THRESHOLD_PCT) {
      const config = this.deps.getConfig();
      const valveName = (_b = (_a = config.valves[valveIndex]) == null ? void 0 : _a.name) != null ? _b : String(valveIndex);
      const message = deviationPct > 0 ? `Valve "${valveName}": Durchfluss ${Math.round(deviationPct)}% \xFCber Erwartung (Rohrbruch?)` : `Valve "${valveName}": Durchfluss ${Math.round(Math.abs(deviationPct))}% unter Erwartung (D\xFCsen verstopft?)`;
      await this.deps.adapter.setStateAsync("watchdog.flowDeviationValve", { val: valveIndex, ack: true });
      await this.deps.adapter.setStateAsync("watchdog.flowDeviationPct", {
        val: Math.round(deviationPct),
        ack: true
      });
      await this.reportIssue(message);
    }
  }
  async reportLeak(valveIndex, flow) {
    var _a, _b;
    await this.deps.adapter.setStateAsync("watchdog.flowActive", { val: true, ack: true });
    const config = this.deps.getConfig();
    const valveName = (_b = (_a = config.valves[valveIndex]) == null ? void 0 : _a.name) != null ? _b : String(valveIndex);
    await this.reportIssue(
      `Leck-Verdacht: Durchfluss ${flow}l/min an Sensor des Ventils "${valveName}", obwohl alle Ventile geschlossen sind.`
    );
  }
  async reportIssue(message) {
    this.deps.adapter.log.warn(`Watchdog: ${message}`);
    await this.deps.adapter.setStateAsync("watchdog.lastIssue", { val: message, ack: true });
    await this.deps.adapter.setStateAsync("watchdog.lastIssueTs", { val: Date.now(), ack: true });
    const countState = await this.deps.adapter.getStateAsync("watchdog.issueCount");
    const count = (typeof (countState == null ? void 0 : countState.val) === "number" ? countState.val : 0) + 1;
    await this.deps.adapter.setStateAsync("watchdog.issueCount", { val: count, ack: true });
    await this.deps.notifications.send("Bew\xE4sserung Watchdog", message);
  }
  async getExpectedFlow(valveIndex) {
    const state = await this.deps.adapter.getStateAsync(
      `valves.valve_${(0, import_types.formatValveNumber)(valveIndex)}.flowExpected`
    );
    return typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
  }
  /**
   * Runs the calibration routine: opens the valve for a fixed
   * duration, samples the flow sensor, and stores the average in the
   * persistent `flowExpected` runtime state (never in native config).
   *
   * The caller (main.ts) is responsible for actually opening/closing the
   * valve via automation/valve controller; this method only manages the
   * sampling window and result persistence.
   *
   * @param valveIndex
   * @param openValve
   * @param closeValve
   */
  async startCalibration(valveIndex, openValve, closeValve) {
    if (this.calibrationActive.has(valveIndex)) {
      return;
    }
    this.calibrationActive.add(valveIndex);
    this.calibrationSamples.set(valveIndex, []);
    await openValve();
    const timer = this.deps.adapter.setTimeout(() => {
      this.calibrationTimers.delete(valveIndex);
      this.finishCalibration(valveIndex, closeValve).catch(
        (error) => this.deps.adapter.log.error(`Calibration failed: ${error.message}`)
      );
    }, CALIBRATION_DURATION_SECS * 1e3);
    this.calibrationTimers.set(valveIndex, timer);
  }
  async finishCalibration(valveIndex, closeValve) {
    var _a;
    await closeValve();
    const samples = (_a = this.calibrationSamples.get(valveIndex)) != null ? _a : [];
    this.calibrationActive.delete(valveIndex);
    this.calibrationSamples.delete(valveIndex);
    if (samples.length === 0) {
      this.deps.adapter.log.warn(`Calibration for valve ${valveIndex} yielded no samples.`);
      return;
    }
    const average = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    await this.deps.adapter.setStateAsync(`valves.valve_${(0, import_types.formatValveNumber)(valveIndex)}.flowExpected`, {
      val: Math.round(average * 100) / 100,
      ack: true
    });
    this.deps.adapter.log.info(`Calibration for valve ${valveIndex} complete: ${average.toFixed(2)} l/min`);
  }
  /** Called on unload/onUnload to release any pending calibration timers. */
  destroy() {
    for (const timer of this.calibrationTimers.values()) {
      this.deps.adapter.clearTimeout(timer);
    }
    this.calibrationTimers.clear();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FlowMonitor
});
//# sourceMappingURL=flow-monitor.js.map
