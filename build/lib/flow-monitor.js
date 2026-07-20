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
const DEVIATION_THRESHOLD_PCT = 30;
const CALIBRATION_DURATION_SECS = 120;
class FlowMonitor {
  deps;
  subscribedIds = /* @__PURE__ */ new Map();
  // stateId -> zoneIndex
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
    for (let i = 0; i < config.zones.length; i++) {
      const id = config.zones[i].flowSensorId;
      if (id) {
        await this.deps.adapter.subscribeForeignStatesAsync(id);
        this.subscribedIds.set(id, i);
      }
    }
  }
  async onForeignStateChange(id, state) {
    var _a;
    const zoneIndex = this.subscribedIds.get(id);
    if (zoneIndex === void 0) {
      return false;
    }
    const flow = typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
    await this.deps.adapter.setStateAsync(`zones.zone_${zoneIndex}.flowActual`, { val: flow, ack: true });
    if (this.calibrationActive.has(zoneIndex)) {
      const samples = (_a = this.calibrationSamples.get(zoneIndex)) != null ? _a : [];
      samples.push(flow);
      this.calibrationSamples.set(zoneIndex, samples);
    } else {
      await this.checkDeviation(zoneIndex, flow);
    }
    if (!this.deps.isAnyZoneRunning() && flow > 0) {
      await this.reportLeak(zoneIndex, flow);
    }
    return true;
  }
  async checkDeviation(zoneIndex, actualFlow) {
    var _a, _b;
    const expected = await this.getExpectedFlow(zoneIndex);
    if (!expected || expected <= 0) {
      return;
    }
    const deviationPct = (actualFlow - expected) / expected * 100;
    if (Math.abs(deviationPct) > DEVIATION_THRESHOLD_PCT) {
      const config = this.deps.getConfig();
      const zoneName = (_b = (_a = config.zones[zoneIndex]) == null ? void 0 : _a.name) != null ? _b : String(zoneIndex);
      const message = deviationPct > 0 ? `Zone "${zoneName}": Durchfluss ${Math.round(deviationPct)}% \xFCber Erwartung (Rohrbruch?)` : `Zone "${zoneName}": Durchfluss ${Math.round(Math.abs(deviationPct))}% unter Erwartung (D\xFCsen verstopft?)`;
      await this.deps.adapter.setStateAsync("watchdog.flowDeviationZone", { val: zoneIndex, ack: true });
      await this.deps.adapter.setStateAsync("watchdog.flowDeviationPct", {
        val: Math.round(deviationPct),
        ack: true
      });
      await this.reportIssue(message);
    }
  }
  async reportLeak(zoneIndex, flow) {
    var _a, _b;
    await this.deps.adapter.setStateAsync("watchdog.flowActive", { val: true, ack: true });
    const config = this.deps.getConfig();
    const zoneName = (_b = (_a = config.zones[zoneIndex]) == null ? void 0 : _a.name) != null ? _b : String(zoneIndex);
    await this.reportIssue(
      `Leck-Verdacht: Durchfluss ${flow}l/min an Sensor der Zone "${zoneName}", obwohl alle Ventile geschlossen sind.`
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
  async getExpectedFlow(zoneIndex) {
    const state = await this.deps.adapter.getStateAsync(`zones.zone_${zoneIndex}.flowExpected`);
    return typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
  }
  /**
   * Runs the calibration routine: opens the zone's valve for a fixed
   * duration, samples the flow sensor, and stores the average in the
   * persistent `flowExpected` runtime state (never in native config).
   *
   * The caller (main.ts) is responsible for actually opening/closing the
   * valve via automation/valve controller; this method only manages the
   * sampling window and result persistence.
   *
   * @param zoneIndex
   * @param openValve
   * @param closeValve
   */
  async startCalibration(zoneIndex, openValve, closeValve) {
    if (this.calibrationActive.has(zoneIndex)) {
      return;
    }
    this.calibrationActive.add(zoneIndex);
    this.calibrationSamples.set(zoneIndex, []);
    await openValve();
    const timer = this.deps.adapter.setTimeout(() => {
      this.calibrationTimers.delete(zoneIndex);
      this.finishCalibration(zoneIndex, closeValve).catch(
        (error) => this.deps.adapter.log.error(`Calibration failed: ${error.message}`)
      );
    }, CALIBRATION_DURATION_SECS * 1e3);
    this.calibrationTimers.set(zoneIndex, timer);
  }
  async finishCalibration(zoneIndex, closeValve) {
    var _a;
    await closeValve();
    const samples = (_a = this.calibrationSamples.get(zoneIndex)) != null ? _a : [];
    this.calibrationActive.delete(zoneIndex);
    this.calibrationSamples.delete(zoneIndex);
    if (samples.length === 0) {
      this.deps.adapter.log.warn(`Calibration for zone ${zoneIndex} yielded no samples.`);
      return;
    }
    const average = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    await this.deps.adapter.setStateAsync(`zones.zone_${zoneIndex}.flowExpected`, {
      val: Math.round(average * 100) / 100,
      ack: true
    });
    this.deps.adapter.log.info(`Calibration for zone ${zoneIndex} complete: ${average.toFixed(2)} l/min`);
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
