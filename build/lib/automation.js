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
var automation_exports = {};
__export(automation_exports, {
  AutomationEngine: () => AutomationEngine,
  buildBatches: () => buildBatches,
  calculateTemperatureAdjustmentFactor: () => calculateTemperatureAdjustmentFactor
});
module.exports = __toCommonJS(automation_exports);
var import_ventile = require("./ventile");
var import_duration = require("./duration");
function calculateTemperatureAdjustmentFactor(temperature) {
  return 1.07 ** (temperature - 20);
}
function buildBatches(valveIndexes, valves, pumpCapacity) {
  if (pumpCapacity <= 0) {
    return valveIndexes.map((idx) => [idx]);
  }
  const sorted = [...valveIndexes].sort((a, b) => valves[b].duration - valves[a].duration);
  const batches = [];
  for (const valveIdx of sorted) {
    const valve = valves[valveIdx];
    const flowRate = valve.flowRateLpm || 0;
    const rainbirdInstance = valve.type === "Rainbird" ? (0, import_ventile.rainbirdInstanceOf)(valve.stateId) : void 0;
    let bestBatch;
    let bestIncrease = Infinity;
    for (const batch of batches) {
      if (batch.flowSum + flowRate > pumpCapacity) {
        continue;
      }
      if (rainbirdInstance && batch.rainbirdInstances.has(rainbirdInstance)) {
        continue;
      }
      const increase = Math.max(0, valve.duration - batch.duration);
      if (increase < bestIncrease) {
        bestIncrease = increase;
        bestBatch = batch;
      }
    }
    if (bestBatch) {
      bestBatch.valveIdxs.push(valveIdx);
      bestBatch.flowSum += flowRate;
      bestBatch.duration = Math.max(bestBatch.duration, valve.duration);
      if (rainbirdInstance) {
        bestBatch.rainbirdInstances.add(rainbirdInstance);
      }
    } else {
      batches.push({
        valveIdxs: [valveIdx],
        flowSum: flowRate,
        duration: valve.duration,
        rainbirdInstances: rainbirdInstance ? /* @__PURE__ */ new Set([rainbirdInstance]) : /* @__PURE__ */ new Set()
      });
    }
  }
  return batches.map((b) => b.valveIdxs);
}
class AutomationEngine {
  deps;
  status = "idle";
  pauseReason = null;
  activePlanName = null;
  batches = [];
  currentBatchIndex = -1;
  runningValves = /* @__PURE__ */ new Set();
  valveEndsAt = /* @__PURE__ */ new Map();
  valveDurationSecs = /* @__PURE__ */ new Map();
  inBatchPause = false;
  batchPauseEndsAt = 0;
  totalDurationMin = 0;
  startedAtMs = 0;
  valvePauseMs = 0;
  temperatureAdjustmentFactor = 1;
  manualRun = null;
  wasAutomationPausedForManual = false;
  wasAutomationBatchIndexBeforeManual = -1;
  tickTimer;
  constructor(deps) {
    this.deps = deps;
  }
  getStatus() {
    return this.status;
  }
  isManualRunActive() {
    return this.manualRun !== null;
  }
  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------
  start() {
    this.tickTimer = this.deps.adapter.setInterval(() => {
      this.tick().catch(
        (error) => this.deps.adapter.log.error(`Automation tick failed: ${error.message}`)
      );
    }, 1e3);
  }
  destroy() {
    if (this.tickTimer) {
      this.deps.adapter.clearInterval(this.tickTimer);
      this.tickTimer = void 0;
    }
  }
  /**
   * Called once at adapter start. Previously this unconditionally called
   * stop() on every configured valve on every single restart - including
   * normal/frequent restarts (config changes, host reloads, etc.) - which
   * meant a Gardena valve started moments earlier from the Gardena app or
   * from ioBroker was immediately closed again by the very next restart,
   * regardless of who/what started it and regardless of whether an
   * automation run was actually interrupted.
   *
   * Only defensively stop valves if the persisted `automation.running`
   * state confirms a plan-driven run was genuinely in progress when the
   * process last shut down (e.g. a real crash mid-run, not a clean
   * shutdown or an unrelated valve being controlled independently), and
   * then only stop the specific valves recorded in `automation.batchZones`
   * - not every configured valve. Manual single-valve runs
   * (requestManualStart()) are not persisted at all and are intentionally
   * left untouched here: there is no reliable evidence either way, and
   * erring on the side of not touching them is what avoids stopping a
   * valve someone just started externally.
   */
  async recoverAfterRestart() {
    const runningState = await this.deps.adapter.getStateAsync("automation.running");
    const wasRunning = (runningState == null ? void 0 : runningState.val) === true;
    if (wasRunning) {
      const batchZonesState = await this.deps.adapter.getStateAsync("automation.batchZones");
      let interruptedValveIndexes = [];
      try {
        const parsed = JSON.parse(typeof (batchZonesState == null ? void 0 : batchZonesState.val) === "string" ? batchZonesState.val : "[]");
        if (Array.isArray(parsed)) {
          interruptedValveIndexes = parsed.filter((v) => typeof v === "number");
        }
      } catch {
        interruptedValveIndexes = [];
      }
      for (const valveIndex of interruptedValveIndexes) {
        const valve = this.deps.valves[valveIndex];
        if (valve) {
          await valve.stop();
        }
      }
    }
    this.status = "idle";
    this.pauseReason = null;
    this.activePlanName = null;
    this.batches = [];
    this.currentBatchIndex = -1;
    this.runningValves.clear();
    this.manualRun = null;
    await this.publishStatus();
  }
  // ------------------------------------------------------------------
  // Plan execution
  // ------------------------------------------------------------------
  /**
   * Entry point for automatic (timer/iCal) or manual "Start" triggers.
   * Applies the priority rules from the plan: ignored unless idle.
   *
   * @param planName
   * @param source
   */
  async requestRun(planName, source) {
    if (this.manualRun) {
      this.deps.adapter.log.warn(`Run request (${source}) ignored: manual valve run in progress.`);
      return;
    }
    if (this.status !== "idle") {
      this.deps.adapter.log.warn(`Run request (${source}) ignored: automation already ${this.status}.`);
      return;
    }
    await this.runPlan(planName);
  }
  async runPlan(planName) {
    const config = this.deps.getConfig();
    const plan = config.plans.find((p) => p.name === planName);
    if (!plan) {
      this.deps.adapter.log.error(
        `Unknown plan "${planName}", available: ${config.plans.map((p) => p.name).join(", ")}`
      );
      await this.deps.adapter.setStateAsync("automation.status", {
        val: `Mode: idle (unbekannter Plan "${planName}")`,
        ack: true
      });
      return;
    }
    const activeValveIndexes = this.buildActiveValveList(config, plan);
    if (activeValveIndexes.length === 0) {
      this.deps.adapter.log.warn(`No active valves for plan "${planName}" today.`);
      await this.deps.adapter.setStateAsync("automation.status", {
        val: `Mode: idle (keine aktiven Ventile heute f\xFCr Plan "${planName}")`,
        ack: true
      });
      return;
    }
    this.activePlanName = plan.name;
    await this.deps.adapter.setStateAsync("automation.planSelect", { val: plan.name, ack: true });
    await this.updateTemperatureAdjustmentFactor(config);
    this.batches = buildBatches(activeValveIndexes, config.valves, config.scheduler.pumpCapacity);
    this.currentBatchIndex = -1;
    this.totalDurationMin = this.computeTotalDurationMin(config);
    this.startedAtMs = Date.now();
    this.valvePauseMs = config.scheduler.valvePause * 60 * 1e3;
    if (this.deps.isLegallyRestricted()) {
      this.deps.adapter.log.warn(`Plan "${plan.name}" prepared but legal restriction is active - waiting.`);
      this.status = "paused";
      this.pauseReason = "legalRestriction";
      await this.publishStatus();
      return;
    }
    this.status = "running";
    await this.startNextBatch();
  }
  async updateTemperatureAdjustmentFactor(config) {
    this.temperatureAdjustmentFactor = 1;
    if (!config.scheduler.temperatureAdjustmentEnabled || !config.scheduler.temperatureAdjustmentStateId) {
      await this.deps.adapter.setStateAsync("automation.temperatureAdjustmentFactor", { val: 1, ack: true });
      return;
    }
    try {
      const temperature = await this.deps.getTemperatureAdjustmentTemperature();
      if (temperature === void 0) {
        throw new Error("configured temperature state has no valid numeric value");
      }
      this.temperatureAdjustmentFactor = calculateTemperatureAdjustmentFactor(temperature);
      await this.deps.adapter.setStateAsync("automation.temperatureAdjustmentFactor", {
        val: this.temperatureAdjustmentFactor,
        ack: true
      });
    } catch (error) {
      this.deps.adapter.log.warn(
        `Temperature-controlled irrigation adjustment disabled for this plan: ${error.message}`
      );
      await this.deps.adapter.setStateAsync("automation.temperatureAdjustmentFactor", { val: 1, ack: true });
    }
  }
  buildActiveValveList(config, plan) {
    const useAllValves = plan.valveIndexes.length === 0;
    const requestedIndexes = config.valves.map((_, index) => index).filter((index) => useAllValves || plan.valveIndexes.includes(index));
    const weekday = (/* @__PURE__ */ new Date()).getDay();
    const result = [];
    const seenIndexes = /* @__PURE__ */ new Set();
    for (const index of requestedIndexes) {
      if (seenIndexes.has(index)) {
        continue;
      }
      seenIndexes.add(index);
      const valve = config.valves[index];
      if (!valve || !valve.enabled) {
        continue;
      }
      if (valve.days.length > 0 && !valve.days.includes(weekday)) {
        continue;
      }
      const blocked = this.deps.isValveBlockedForAutoRun(index);
      if (blocked.blocked) {
        this.deps.adapter.log.debug(`Valve ${valve.name} skipped: ${blocked.reason}`);
        continue;
      }
      result.push(index);
    }
    return result;
  }
  computeTotalDurationMin(config) {
    let totalSeconds = 0;
    for (const batch of this.batches) {
      totalSeconds += Math.max(...batch.map((idx) => this.effectiveDuration(config, idx)));
    }
    if (config.scheduler.valvePause > 0 && this.batches.length > 1) {
      totalSeconds += config.scheduler.valvePause * 60 * (this.batches.length - 1);
    }
    return totalSeconds / 60;
  }
  effectiveDuration(config, valveIndex) {
    return config.valves[valveIndex].duration * config.scheduler.extensionFactor * this.temperatureAdjustmentFactor;
  }
  async startNextBatch() {
    var _a, _b;
    this.currentBatchIndex++;
    if (this.currentBatchIndex >= this.batches.length) {
      await this.finishRun();
      return;
    }
    const config = this.deps.getConfig();
    const batch = this.batches[this.currentBatchIndex];
    this.runningValves = new Set(batch);
    this.inBatchPause = false;
    for (const valveIndex of batch) {
      const durationSecs = Math.round(this.effectiveDuration(config, valveIndex));
      this.valveDurationSecs.set(valveIndex, durationSecs);
      this.valveEndsAt.set(valveIndex, Date.now() + durationSecs * 1e3);
      await this.deps.valves[valveIndex].start(durationSecs);
      (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, valveIndex, true);
    }
    await this.deps.adapter.setStateAsync("automation.currentBatch", {
      val: this.currentBatchIndex + 1,
      ack: true
    });
    await this.deps.adapter.setStateAsync("automation.totalBatches", { val: this.batches.length, ack: true });
    await this.deps.adapter.setStateAsync("automation.batchZones", {
      val: JSON.stringify(batch),
      ack: true
    });
    await this.publishStatus();
  }
  async finishRun() {
    this.status = "idle";
    this.pauseReason = null;
    this.activePlanName = null;
    this.batches = [];
    this.currentBatchIndex = -1;
    this.runningValves.clear();
    await this.deps.adapter.setStateAsync("automation.currentBatch", { val: 0, ack: true });
    await this.deps.adapter.setStateAsync("automation.batchZones", { val: "[]", ack: true });
    await this.publishStatus();
  }
  // ------------------------------------------------------------------
  // Tick / batch pause / watchdog handling
  // ------------------------------------------------------------------
  async tick() {
    var _a, _b;
    if (this.manualRun) {
      if (Date.now() >= this.manualRun.endsAt) {
        await this.finishManualRun();
      }
      return;
    }
    if (this.status !== "running") {
      return;
    }
    if (this.inBatchPause) {
      if (Date.now() >= this.batchPauseEndsAt) {
        this.inBatchPause = false;
        await this.startNextBatch();
      } else {
        await this.publishStatus();
      }
      return;
    }
    const stillRunning = [...this.runningValves].filter((idx) => {
      var _a2;
      return Date.now() < ((_a2 = this.valveEndsAt.get(idx)) != null ? _a2 : 0);
    });
    if (stillRunning.length !== this.runningValves.size) {
      for (const idx of this.runningValves) {
        if (!stillRunning.includes(idx)) {
          (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, idx, false);
        }
      }
      this.runningValves = new Set(stillRunning);
    }
    if (this.runningValves.size === 0) {
      const config = this.deps.getConfig();
      if (config.scheduler.valvePause > 0 && this.currentBatchIndex < this.batches.length - 1) {
        this.inBatchPause = true;
        this.batchPauseEndsAt = Date.now() + this.valvePauseMs;
        await this.publishStatus();
      } else {
        await this.startNextBatch();
      }
      return;
    }
    await this.publishStatus();
  }
  // ------------------------------------------------------------------
  // Controls: stop / pause / next / back
  // ------------------------------------------------------------------
  async stop() {
    var _a, _b;
    if (this.manualRun) {
      await this.stopManualRun();
      await this.resetDurationStates();
      return;
    }
    if (this.status === "idle") {
      await this.resetDurationStates();
      return;
    }
    for (const idx of this.runningValves) {
      await this.deps.valves[idx].stop();
      (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, idx, false);
    }
    this.runningValves.clear();
    await this.resetDurationStates();
    await this.finishRun();
  }
  async pause() {
    var _a;
    if (this.manualRun) {
      return;
    }
    if (this.status === "running") {
      for (const idx of this.runningValves) {
        await this.deps.valves[idx].stop();
      }
      this.status = "paused";
      this.pauseReason = "manual";
      await this.publishStatus();
    } else if (this.status === "paused") {
      if (this.pauseReason === "legalRestriction" && this.deps.isLegallyRestricted()) {
        this.deps.adapter.log.warn("Resume refused: legal restriction still active.");
        return;
      }
      if (this.pauseReason === "rain" && this.deps.isRaining()) {
        this.deps.adapter.log.warn("Resume refused: rain is still detected.");
        return;
      }
      if (this.pauseReason === "wind" && this.deps.isWindOverLimit()) {
        this.deps.adapter.log.warn("Resume refused: wind speed/gust is still over the configured limit.");
        return;
      }
      this.status = "running";
      this.pauseReason = null;
      for (const idx of this.runningValves) {
        const remaining = Math.max(0, Math.round((((_a = this.valveEndsAt.get(idx)) != null ? _a : 0) - Date.now()) / 1e3));
        await this.deps.valves[idx].start(remaining);
      }
      await this.publishStatus();
    }
  }
  async setRainPause(raining) {
    var _a, _b, _c, _d, _e;
    if (this.manualRun || !this.deps.getConfig().scheduler.pauseOnRain) {
      return;
    }
    if (raining && this.status === "running") {
      for (const idx of this.runningValves) {
        await this.deps.valves[idx].stop();
        (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, idx, false);
      }
      this.status = "paused";
      this.pauseReason = "rain";
      await this.publishStatus();
      return;
    }
    if (!raining && this.status === "paused" && this.pauseReason === "rain") {
      this.status = "running";
      this.pauseReason = null;
      for (const idx of this.runningValves) {
        const remaining = Math.max(0, Math.round((((_c = this.valveEndsAt.get(idx)) != null ? _c : 0) - Date.now()) / 1e3));
        if (remaining > 0) {
          await this.deps.valves[idx].start(remaining);
          (_e = (_d = this.deps).onValveFlowChange) == null ? void 0 : _e.call(_d, idx, true);
        }
      }
      await this.publishStatus();
    }
  }
  async setWindPause(paused) {
    var _a, _b, _c, _d, _e;
    if (this.manualRun || !this.deps.getConfig().scheduler.windPauseEnabled) {
      return;
    }
    if (paused && this.status === "running") {
      for (const idx of this.runningValves) {
        await this.deps.valves[idx].stop();
        (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, idx, false);
      }
      this.status = "paused";
      this.pauseReason = "wind";
      await this.publishStatus();
      return;
    }
    if (!paused && this.status === "paused" && this.pauseReason === "wind") {
      this.status = "running";
      this.pauseReason = null;
      for (const idx of this.runningValves) {
        const remaining = Math.max(0, Math.round((((_c = this.valveEndsAt.get(idx)) != null ? _c : 0) - Date.now()) / 1e3));
        if (remaining > 0) {
          await this.deps.valves[idx].start(remaining);
          (_e = (_d = this.deps).onValveFlowChange) == null ? void 0 : _e.call(_d, idx, true);
        }
      }
      await this.publishStatus();
    }
  }
  async next() {
    var _a, _b;
    if (this.manualRun) {
      return;
    }
    if (this.status !== "running" && this.status !== "paused") {
      return;
    }
    for (const idx of this.runningValves) {
      await this.deps.valves[idx].stop();
      (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, idx, false);
    }
    this.runningValves.clear();
    this.inBatchPause = false;
    if (this.status === "paused") {
      this.currentBatchIndex++;
      await this.publishStatus();
      return;
    }
    await this.startNextBatch();
  }
  async back() {
    var _a, _b;
    if (this.manualRun) {
      return;
    }
    if (this.status !== "running" && this.status !== "paused") {
      return;
    }
    for (const idx of this.runningValves) {
      await this.deps.valves[idx].stop();
      (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, idx, false);
    }
    this.runningValves.clear();
    this.inBatchPause = false;
    if (this.currentBatchIndex > 0) {
      this.currentBatchIndex -= 2;
    } else {
      this.currentBatchIndex = -1;
    }
    if (this.status === "paused") {
      this.currentBatchIndex++;
      await this.publishStatus();
      return;
    }
    await this.startNextBatch();
  }
  // ------------------------------------------------------------------
  // Manual single-valve runs
  // ------------------------------------------------------------------
  async manualStartValve(valveIndex) {
    var _a, _b;
    if (this.manualRun) {
      this.deps.adapter.log.warn("Manual valve start ignored: another manual run is already active.");
      return;
    }
    const config = this.deps.getConfig();
    const valve = config.valves[valveIndex];
    if (!valve) {
      this.deps.adapter.log.error(`Manual start for valve ${valveIndex} failed: valve not found.`);
      return;
    }
    this.wasAutomationPausedForManual = false;
    if (this.status === "running") {
      for (const idx of this.runningValves) {
        await this.deps.valves[idx].stop();
      }
      this.wasAutomationBatchIndexBeforeManual = this.currentBatchIndex;
      this.status = "paused";
      this.pauseReason = "manual";
      this.wasAutomationPausedForManual = true;
    }
    const durationSecs = Math.round(valve.manualDuration);
    this.manualRun = { valveIndex, endsAt: Date.now() + durationSecs * 1e3 };
    await this.deps.valves[valveIndex].start(durationSecs);
    (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, valveIndex, true);
    await this.publishStatus();
  }
  async finishManualRun() {
    var _a, _b;
    if (!this.manualRun) {
      return;
    }
    await this.deps.valves[this.manualRun.valveIndex].stop();
    (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, this.manualRun.valveIndex, false);
    this.manualRun = null;
    if (this.wasAutomationPausedForManual) {
      this.status = "running";
      this.pauseReason = null;
      this.currentBatchIndex = this.wasAutomationBatchIndexBeforeManual;
      await this.startNextBatch();
    } else {
      await this.publishStatus();
    }
  }
  async stopManualRun() {
    var _a, _b;
    if (!this.manualRun) {
      return;
    }
    await this.deps.valves[this.manualRun.valveIndex].stop();
    (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, this.manualRun.valveIndex, false);
    this.manualRun = null;
    this.wasAutomationPausedForManual = false;
    await this.finishRun();
  }
  // ------------------------------------------------------------------
  // Legal restriction integration (called by dwd.ts)
  // ------------------------------------------------------------------
  async onLegalRestrictionChanged(active) {
    var _a;
    if (active) {
      if (this.status === "running") {
        for (const idx of this.runningValves) {
          await this.deps.valves[idx].stop();
        }
        this.status = "paused";
        this.pauseReason = "legalRestriction";
        await this.publishStatus();
      } else if (this.status === "paused" && this.pauseReason === null) {
        this.pauseReason = "legalRestriction";
      }
    } else if (this.pauseReason === "legalRestriction") {
      this.pauseReason = null;
      if (this.status === "paused") {
        if (this.currentBatchIndex === -1) {
          this.status = "running";
          await this.startNextBatch();
        } else {
          this.status = "running";
          for (const idx of this.runningValves) {
            const remaining = Math.max(
              0,
              Math.round((((_a = this.valveEndsAt.get(idx)) != null ? _a : 0) - Date.now()) / 1e3)
            );
            await this.deps.valves[idx].start(remaining);
          }
          await this.publishStatus();
        }
      }
    }
  }
  // ------------------------------------------------------------------
  // Status text
  // ------------------------------------------------------------------
  async resetDurationStates() {
    this.startedAtMs = 0;
    this.totalDurationMin = 0;
    this.temperatureAdjustmentFactor = 1;
    await this.deps.adapter.setStateAsync("automation.elapsedTime", { val: 0, ack: true });
    await this.deps.adapter.setStateAsync("automation.remainingTime", { val: 0, ack: true });
    await this.deps.adapter.setStateAsync("automation.remainingDurationMin", { val: (0, import_duration.formatDuration)(0), ack: true });
    await this.deps.adapter.setStateAsync("automation.totalDuration", { val: 0, ack: true });
    await this.deps.adapter.setStateAsync("automation.temperatureAdjustmentFactor", { val: 1, ack: true });
  }
  async publishStatus() {
    var _a, _b;
    const config = this.deps.getConfig();
    let text = `Mode: ${this.status}`;
    if (this.manualRun) {
      const valve = config.valves[this.manualRun.valveIndex];
      const remainingSecs2 = Math.max(0, Math.round((this.manualRun.endsAt - Date.now()) / 1e3));
      text = `Mode: manual (${(_a = valve == null ? void 0 : valve.name) != null ? _a : this.manualRun.valveIndex}, noch ${Math.ceil(remainingSecs2 / 60)}min)`;
    } else if (this.status !== "idle" && this.activePlanName) {
      text += ` (Plan: ${this.activePlanName})`;
      if (this.pauseReason === "legalRestriction") {
        text += " (gesetzliche Beregnungssperre aktiv)";
      }
      if (this.inBatchPause) {
        const remaining = Math.max(0, Math.round((this.batchPauseEndsAt - Date.now()) / 1e3 / 60));
        text += ` - Pause (Versickerung), noch ${remaining}min`;
      } else if (this.runningValves.size > 0) {
        const valveNames = [...this.runningValves].map((idx) => {
          var _a2, _b2, _c;
          const remaining = Math.max(
            0,
            Math.round((((_a2 = this.valveEndsAt.get(idx)) != null ? _a2 : 0) - Date.now()) / 1e3 / 60)
          );
          return `${(_c = (_b2 = config.valves[idx]) == null ? void 0 : _b2.name) != null ? _c : idx} (${remaining}min)`;
        }).join(", ");
        text += ` - Batch ${this.currentBatchIndex + 1}/${this.batches.length}: ${valveNames}`;
      }
    }
    await this.deps.adapter.setStateAsync("automation.status", { val: text, ack: true });
    await this.deps.adapter.setStateAsync("automation.running", {
      val: this.status === "running" || this.status === "paused" || this.manualRun !== null,
      ack: true
    });
    const elapsedSecs = this.startedAtMs > 0 ? Math.floor((Date.now() - this.startedAtMs) / 1e3) : 0;
    const totalDurationSecs = this.totalDurationMin * 60;
    const remainingSecs = Math.max(0, totalDurationSecs - elapsedSecs);
    await this.deps.adapter.setStateAsync("automation.elapsedTime", { val: elapsedSecs, ack: true });
    await this.deps.adapter.setStateAsync("automation.remainingTime", {
      val: remainingSecs,
      ack: true
    });
    await this.deps.adapter.setStateAsync("automation.remainingDurationMin", {
      val: (0, import_duration.formatDuration)(remainingSecs),
      ack: true
    });
    await this.deps.adapter.setStateAsync("automation.totalDuration", { val: totalDurationSecs, ack: true });
    await this.deps.adapter.setStateAsync("automation.activePlan", { val: (_b = this.activePlanName) != null ? _b : "", ack: true });
    await this.deps.adapter.setStateAsync("automation.currentZone", {
      val: this.runningValves.size > 0 ? [...this.runningValves][0] : -1,
      ack: true
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AutomationEngine,
  buildBatches,
  calculateTemperatureAdjustmentFactor
});
//# sourceMappingURL=automation.js.map
