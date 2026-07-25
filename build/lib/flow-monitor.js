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
  CALIBRATION_DURATION_SECS: () => CALIBRATION_DURATION_SECS,
  FlowMonitor: () => FlowMonitor
});
module.exports = __toCommonJS(flow_monitor_exports);
var import_types = require("./types");
const DEVIATION_THRESHOLD_PCT = 30;
const CALIBRATION_DURATION_SECS = 120;
class FlowMonitor {
  deps;
  subscribedId;
  calibrationSamples = [];
  calibratingValveIndex;
  calibrationTimer;
  constructor(deps) {
    this.deps = deps;
  }
  async init() {
    await this.resubscribe();
  }
  async resubscribe() {
    if (this.subscribedId) {
      await this.deps.adapter.unsubscribeForeignStatesAsync(this.subscribedId);
      this.subscribedId = void 0;
    }
    const config = this.deps.getConfig();
    const id = config.flowMonitor.enabled ? config.flowMonitor.sensorId.trim() : "";
    if (id) {
      await this.deps.adapter.subscribeForeignStatesAsync(id);
      this.subscribedId = id;
    }
  }
  async onForeignStateChange(id, state) {
    if (id !== this.subscribedId) {
      return false;
    }
    const flow = typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
    await this.deps.adapter.setStateAsync("watchdog.flowActual", { val: flow, ack: true });
    if (this.calibratingValveIndex !== void 0) {
      this.calibrationSamples.push(flow);
    } else {
      const runningIndexes = this.deps.getRunningValveIndexes();
      await this.checkDeviation(runningIndexes, flow);
      if (runningIndexes.length === 0 && flow > 0) {
        await this.reportLeak(flow);
      } else {
        await this.deps.adapter.setStateAsync("watchdog.flowActive", { val: false, ack: true });
      }
    }
    return true;
  }
  async checkDeviation(runningIndexes, actualFlow) {
    var _a, _b;
    if (runningIndexes.length === 0) {
      return;
    }
    const config = this.deps.getConfig();
    let expected = 0;
    for (const idx of runningIndexes) {
      expected += await this.getExpectedFlow(idx);
    }
    if (expected <= 0) {
      return;
    }
    const deviationPct = (actualFlow - expected) / expected * 100;
    if (Math.abs(deviationPct) > DEVIATION_THRESHOLD_PCT) {
      const label = runningIndexes.length === 1 ? `Valve "${(_b = (_a = config.valves[runningIndexes[0]]) == null ? void 0 : _a.name) != null ? _b : runningIndexes[0]}"` : `Valves ${runningIndexes.map((idx) => {
        var _a2, _b2;
        return `"${(_b2 = (_a2 = config.valves[idx]) == null ? void 0 : _a2.name) != null ? _b2 : idx}"`;
      }).join(", ")}`;
      const message = deviationPct > 0 ? `${label}: Durchfluss ${Math.round(deviationPct)}% \xFCber Erwartung (Rohrbruch?)` : `${label}: Durchfluss ${Math.round(Math.abs(deviationPct))}% unter Erwartung (D\xFCsen verstopft?)`;
      await this.deps.adapter.setStateAsync("watchdog.flowDeviationValve", {
        val: runningIndexes.length === 1 ? runningIndexes[0] : -1,
        ack: true
      });
      await this.deps.adapter.setStateAsync("watchdog.flowDeviationPct", {
        val: Math.round(deviationPct),
        ack: true
      });
      await this.reportIssue(message);
    }
  }
  async reportLeak(flow) {
    await this.deps.adapter.setStateAsync("watchdog.flowActive", { val: true, ack: true });
    await this.reportIssue(
      `Leck-Verdacht: Durchfluss ${flow}l/min am Durchflusssensor, obwohl alle Ventile geschlossen sind.`
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
  /**
   * Builds the `valves.valve_XXX` object-id suffix for a valve's array
   * index. The real object id is derived from the valve's stable
   * `IValveConfig.id` (see ventile.ts's `id` getter), not its current
   * array position - the two can differ once valves have been
   * reordered/deleted/re-added, so this must never use `valveIndex`
   * directly.
   *
   * @param valveIndex
   */
  objectSuffixFor(valveIndex) {
    var _a, _b;
    const config = this.deps.getConfig();
    return (0, import_types.formatValveNumber)((_b = (_a = config.valves[valveIndex]) == null ? void 0 : _a.id) != null ? _b : valveIndex);
  }
  async getExpectedFlow(valveIndex) {
    const state = await this.deps.adapter.getStateAsync(
      `valves.valve_${this.objectSuffixFor(valveIndex)}.flowExpected`
    );
    return typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
  }
  /**
   * Runs the calibration routine: opens exactly one valve for a fixed
   * duration, samples the shared flow sensor, and stores the average in
   * that valve's persistent `flowExpected` runtime state (never in native
   * config). Since there is only one shared sensor for the whole
   * installation, only one calibration can run at a time, and it is
   * rejected outright while any other valve is already running - a
   * reading taken while other valves are open cannot be attributed to the
   * valve being calibrated.
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
    if (this.calibratingValveIndex !== void 0) {
      this.deps.adapter.log.warn(
        `Calibration for valve ${valveIndex} rejected: valve ${this.calibratingValveIndex} is already being calibrated.`
      );
      return;
    }
    if (this.deps.getRunningValveIndexes().length > 0) {
      this.deps.adapter.log.warn(
        `Calibration for valve ${valveIndex} rejected: another valve is currently running, so the shared flow sensor's reading could not be attributed to this valve alone.`
      );
      return;
    }
    if (!this.subscribedId) {
      this.deps.adapter.log.warn(
        `Calibration for valve ${valveIndex} rejected: no flow sensor configured/enabled (flowMonitor.sensorId).`
      );
      return;
    }
    this.calibratingValveIndex = valveIndex;
    this.calibrationSamples = [];
    try {
      await openValve();
    } catch (error) {
      this.calibratingValveIndex = void 0;
      this.calibrationSamples = [];
      this.deps.adapter.log.error(
        `Calibration for valve ${valveIndex} failed to open the valve: ${error.message}`
      );
      return;
    }
    this.calibrationTimer = this.deps.adapter.setTimeout(() => {
      this.calibrationTimer = void 0;
      this.finishCalibration(valveIndex, closeValve).catch(
        (error) => this.deps.adapter.log.error(`Calibration failed: ${error.message}`)
      );
    }, CALIBRATION_DURATION_SECS * 1e3);
  }
  async finishCalibration(valveIndex, closeValve) {
    await closeValve();
    const samples = this.calibrationSamples;
    this.calibratingValveIndex = void 0;
    this.calibrationSamples = [];
    if (samples.length === 0) {
      this.deps.adapter.log.warn(`Calibration for valve ${valveIndex} yielded no samples.`);
      return;
    }
    const average = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    await this.deps.adapter.setStateAsync(`valves.valve_${this.objectSuffixFor(valveIndex)}.flowExpected`, {
      val: Math.round(average * 100) / 100,
      ack: true
    });
    this.deps.adapter.log.info(`Calibration for valve ${valveIndex} complete: ${average.toFixed(2)} l/min`);
  }
  /** Called on unload/onUnload to release any pending calibration timer. */
  destroy() {
    if (this.calibrationTimer) {
      this.deps.adapter.clearTimeout(this.calibrationTimer);
      this.calibrationTimer = void 0;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CALIBRATION_DURATION_SECS,
  FlowMonitor
});
//# sourceMappingURL=flow-monitor.js.map
