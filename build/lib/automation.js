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
  /**
   * Internal, independently tracked blocker flags. Unlike the single
   * `pauseReason` enum (still maintained above for status-text
   * compatibility), these can all be active at the same time - e.g. a
   * legal restriction and rain can both be in effect simultaneously. Every
   * resume path (pause(), setRainPause(), setWindPause(),
   * finishManualRun(), onLegalRestrictionChanged()) must re-check all four
   * flags/conditions before actually resuming, so ending one blocker never
   * resumes watering while another is still active.
   */
  blockedByRain = false;
  blockedByWind = false;
  blockedByLegalRestriction = false;
  blockedManually = false;
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
  /** Last remaining-minutes value shown in automation.status during a manual run, used to throttle publishStatus() to only fire when the displayed value actually changes. */
  lastManualRunRemainingMin = -1;
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
   * Unconditionally stops every configured valve so the adapter always starts
   * from a known, consistent "all off" state - regardless of whether an
   * automation run was actually in progress, and regardless of whether a
   * valve is currently being controlled independently (e.g. from the
   * Gardena app or another ioBroker adapter). This intentionally trades
   * away the previous "only touch valves that were genuinely part of an
   * interrupted run" behavior in favor of a guaranteed consistent state on
   * every adapter start/restart.
   */
  async recoverAfterRestart() {
    for (const valve of this.deps.valves) {
      await valve.stop();
    }
    this.status = "idle";
    this.clearAllBlockers();
    this.activePlanName = null;
    this.batches = [];
    this.currentBatchIndex = -1;
    this.runningValves.clear();
    this.manualRun = null;
    await this.publishStatus();
  }
  /**
   * Clears all independently tracked blocker flags. Used when a run
   * finishes/is reset entirely (recoverAfterRestart, finishRun) so no
   * stale blocker from a previous run can affect the next one.
   */
  clearAllBlockers() {
    this.blockedByRain = false;
    this.blockedByWind = false;
    this.blockedByLegalRestriction = false;
    this.blockedManually = false;
    this.pauseReason = null;
  }
  /**
   * The single most relevant blocker for status-text display purposes,
   * derived from the independently tracked flags. Priority order:
   * legal restriction, then rain, then wind, then manual - matches the
   * previous single-`pauseReason` behavior's display priority as closely
   * as possible while allowing multiple blockers to be tracked
   * internally at once.
   */
  computeDisplayPauseReason() {
    if (this.blockedByLegalRestriction) {
      return "legalRestriction";
    }
    if (this.blockedByRain) {
      return "rain";
    }
    if (this.blockedByWind) {
      return "wind";
    }
    if (this.blockedManually) {
      return "manual";
    }
    return null;
  }
  /** True if any blocker is currently active. */
  hasActiveBlocker() {
    return this.blockedByRain || this.blockedByWind || this.blockedByLegalRestriction || this.blockedManually;
  }
  /**
   * Re-checks all four blocker conditions live (rain/wind/legal
   * restriction sensors plus the manual flag) and resumes the paused run
   * only if none of them are (still) active. Called from every
   * resume-triggering path (pause(), setRainPause(), setWindPause(),
   * onLegalRestrictionChanged(), finishManualRun()) after clearing the one
   * blocker that just ended, so overlapping blockers can never be papered
   * over by resuming while another one is still in effect.
   */
  async tryResume() {
    var _a;
    if (this.status !== "paused" || this.manualRun) {
      return;
    }
    this.blockedByLegalRestriction = this.deps.isLegallyRestricted();
    this.blockedByRain = this.deps.getConfig().scheduler.pauseOnRain && this.deps.isRaining();
    this.blockedByWind = this.deps.getConfig().scheduler.windPauseEnabled && this.deps.isWindOverLimit();
    if (this.hasActiveBlocker()) {
      this.pauseReason = this.computeDisplayPauseReason();
      this.deps.adapter.log.warn(`Resume refused: still blocked (${(_a = this.pauseReason) != null ? _a : "unknown reason"}).`);
      await this.publishStatus();
      return;
    }
    this.pauseReason = null;
    this.status = "running";
    if (this.currentBatchIndex === -1) {
      await this.startNextBatch();
    } else {
      await this.resumeRunningValves();
      await this.publishStatus();
    }
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
      this.blockedByLegalRestriction = true;
      this.pauseReason = this.computeDisplayPauseReason();
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
  /**
   * Computes the "logical" elapsed time (in seconds) that would have passed
   * once `targetBatchIndex` batches have completed and the batch at that
   * index is about to start: the sum of the (max) durations of all batches
   * before `targetBatchIndex`, plus one `valvePause` for each transition
   * between them. This mirrors the pause/duration accounting used by
   * `computeTotalDurationMin()`.
   *
   * @param config
   * @param targetBatchIndex
   */
  computeElapsedSecsUpToBatch(config, targetBatchIndex) {
    let secs = 0;
    for (let i = 0; i < targetBatchIndex && i < this.batches.length; i++) {
      secs += Math.round(Math.max(...this.batches[i].map((idx) => this.effectiveDuration(config, idx))));
    }
    if (config.scheduler.valvePause > 0) {
      const pauseCount = Math.max(0, Math.min(targetBatchIndex, this.batches.length - 1));
      secs += config.scheduler.valvePause * 60 * pauseCount;
    }
    return secs;
  }
  /**
   * Resyncs `startedAtMs` so that `automation.remainingTime`/`automation.elapsedTime`
   * (computed from `startedAtMs` and `totalDurationMin` in `publishStatus()`) reflect
   * the batches actually still ahead after a manual Next/Back skip, rather than the
   * real wall-clock time elapsed since the run originally started. Without this, Next
   * jumping ahead (or Back jumping behind) would leave the remaining-time estimate
   * based on the original linear timeline, which no longer matches reality once
   * batches are skipped or repeated.
   *
   * @param targetBatchIndex Index of the batch that is about to start (or, when
   *   paused, the batch that will start once resumed).
   */
  resyncStartedAtForBatchIndex(targetBatchIndex) {
    if (this.batches.length === 0) {
      return;
    }
    const config = this.deps.getConfig();
    const elapsedSecs = this.computeElapsedSecsUpToBatch(config, targetBatchIndex);
    this.startedAtMs = Date.now() - elapsedSecs * 1e3;
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
    await this.deps.adapter.setStateAsync("automation.batchValves", {
      val: JSON.stringify(batch),
      ack: true
    });
    await this.publishStatus();
  }
  async finishRun() {
    this.status = "idle";
    this.clearAllBlockers();
    this.activePlanName = null;
    this.batches = [];
    this.currentBatchIndex = -1;
    this.runningValves.clear();
    await this.deps.adapter.setStateAsync("automation.currentBatch", { val: 0, ack: true });
    await this.deps.adapter.setStateAsync("automation.batchValves", { val: "[]", ack: true });
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
      } else {
        const remainingSecs = Math.max(0, Math.round((this.manualRun.endsAt - Date.now()) / 1e3));
        const remainingMin = Math.ceil(remainingSecs / 60);
        if (remainingMin !== this.lastManualRunRemainingMin) {
          this.lastManualRunRemainingMin = remainingMin;
          await this.publishStatus();
        }
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
    if (this.manualRun) {
      await this.stopManualRun();
      await this.resetDurationStates();
      return;
    }
    if (this.status === "idle") {
      await this.resetDurationStates();
      return;
    }
    await this.stopRunningValves();
    this.runningValves.clear();
    await this.resetDurationStates();
    await this.finishRun();
  }
  /**
   * Stops every valve currently in `runningValves` and notifies
   * `onValveFlowChange(idx, false)` for each. Shared by stop(), pause(),
   * setRainPause(), setWindPause(), next(), back(), manualStartValve(),
   * and onLegalRestrictionChanged() so this stop-and-notify sequence
   * cannot silently diverge between callers.
   */
  async stopRunningValves() {
    var _a, _b;
    for (const idx of this.runningValves) {
      await this.deps.valves[idx].stop();
      (_b = (_a = this.deps).onValveFlowChange) == null ? void 0 : _b.call(_a, idx, false);
    }
  }
  /**
   * Restarts every valve currently in `runningValves` with its remaining
   * time (from `valveEndsAt`) and notifies `onValveFlowChange(idx, true)`
   * for each. Shared by tryResume() (used by pause()/setRainPause()/
   * setWindPause()/onLegalRestrictionChanged()'s resume paths) and
   * finishManualRun(). Valves whose remaining time has already elapsed
   * are skipped rather than restarted with 0/negative duration.
   */
  async resumeRunningValves() {
    var _a, _b, _c;
    for (const idx of this.runningValves) {
      const remaining = Math.max(0, Math.round((((_a = this.valveEndsAt.get(idx)) != null ? _a : 0) - Date.now()) / 1e3));
      if (remaining > 0) {
        await this.deps.valves[idx].start(remaining);
        this.valveEndsAt.set(idx, Date.now() + remaining * 1e3);
        (_c = (_b = this.deps).onValveFlowChange) == null ? void 0 : _c.call(_b, idx, true);
      }
    }
  }
  async pause() {
    if (this.manualRun) {
      return;
    }
    if (this.status === "running") {
      await this.stopRunningValves();
      this.status = "paused";
      this.blockedManually = true;
      this.pauseReason = this.computeDisplayPauseReason();
      await this.publishStatus();
    } else if (this.status === "paused") {
      this.blockedManually = false;
      await this.tryResume();
    }
  }
  async setRainPause(raining) {
    if (this.manualRun || !this.deps.getConfig().scheduler.pauseOnRain) {
      return;
    }
    if (raining) {
      if (this.status === "running") {
        await this.stopRunningValves();
        this.status = "paused";
      }
      if (this.status === "paused") {
        this.blockedByRain = true;
        this.pauseReason = this.computeDisplayPauseReason();
        await this.publishStatus();
      }
      return;
    }
    if (this.blockedByRain) {
      this.blockedByRain = false;
      await this.tryResume();
    }
  }
  async setWindPause(paused) {
    if (this.manualRun || !this.deps.getConfig().scheduler.windPauseEnabled) {
      return;
    }
    if (paused) {
      if (this.status === "running") {
        await this.stopRunningValves();
        this.status = "paused";
      }
      if (this.status === "paused") {
        this.blockedByWind = true;
        this.pauseReason = this.computeDisplayPauseReason();
        await this.publishStatus();
      }
      return;
    }
    if (this.blockedByWind) {
      this.blockedByWind = false;
      await this.tryResume();
    }
  }
  async next() {
    if (this.manualRun) {
      return;
    }
    if (this.status !== "running" && this.status !== "paused") {
      return;
    }
    await this.stopRunningValves();
    this.runningValves.clear();
    this.inBatchPause = false;
    if (this.status === "paused") {
      this.currentBatchIndex++;
      this.resyncStartedAtForBatchIndex(this.currentBatchIndex);
      await this.publishStatus();
      return;
    }
    this.resyncStartedAtForBatchIndex(this.currentBatchIndex + 1);
    await this.startNextBatch();
  }
  async back() {
    if (this.manualRun) {
      return;
    }
    if (this.status !== "running" && this.status !== "paused") {
      return;
    }
    await this.stopRunningValves();
    this.runningValves.clear();
    this.inBatchPause = false;
    if (this.currentBatchIndex > 0) {
      this.currentBatchIndex -= 2;
    } else {
      this.currentBatchIndex = -1;
    }
    if (this.status === "paused") {
      this.currentBatchIndex++;
      this.resyncStartedAtForBatchIndex(this.currentBatchIndex);
      await this.publishStatus();
      return;
    }
    this.resyncStartedAtForBatchIndex(this.currentBatchIndex + 1);
    await this.startNextBatch();
  }
  // ------------------------------------------------------------------
  // Manual single-valve runs
  // ------------------------------------------------------------------
  async manualSetValveState(valveIndex, requestedOn) {
    var _a, _b, _c, _d;
    if (requestedOn) {
      await this.manualStartValve(valveIndex);
      return;
    }
    if (((_a = this.manualRun) == null ? void 0 : _a.valveIndex) === valveIndex) {
      await this.stopManualRun();
      return;
    }
    await ((_b = this.deps.valves[valveIndex]) == null ? void 0 : _b.stop());
    (_d = (_c = this.deps).onValveFlowChange) == null ? void 0 : _d.call(_c, valveIndex, false);
  }
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
    if (!valve.enabled) {
      this.deps.adapter.log.warn(
        `Manual start for valve ${valve.name} ignored: valve is disabled. The running automation, if any, was left untouched.`
      );
      return;
    }
    this.wasAutomationPausedForManual = false;
    if (this.status === "running") {
      await this.stopRunningValves();
      this.status = "paused";
      this.blockedManually = true;
      this.pauseReason = this.computeDisplayPauseReason();
      this.wasAutomationPausedForManual = true;
    }
    const durationSecs = Math.round(valve.manualDuration);
    this.manualRun = { valveIndex, endsAt: Date.now() + durationSecs * 1e3 };
    this.lastManualRunRemainingMin = Math.ceil(durationSecs / 60);
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
      this.wasAutomationPausedForManual = false;
      this.blockedManually = false;
      await this.tryResume();
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
    if (active) {
      if (this.status === "running") {
        await this.stopRunningValves();
        this.status = "paused";
      }
      if (this.status === "paused") {
        this.blockedByLegalRestriction = true;
        this.pauseReason = this.computeDisplayPauseReason();
        await this.publishStatus();
      }
      return;
    }
    if (this.blockedByLegalRestriction) {
      this.blockedByLegalRestriction = false;
      await this.tryResume();
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
    await this.deps.adapter.setStateAsync("automation.remainingDuration", { val: 0, ack: true });
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
    await this.deps.adapter.setStateAsync("automation.remainingDuration", {
      val: remainingSecs,
      ack: true
    });
    await this.deps.adapter.setStateAsync("automation.remainingDurationMin", {
      val: (0, import_duration.formatDuration)(remainingSecs),
      ack: true
    });
    await this.deps.adapter.setStateAsync("automation.totalDuration", { val: totalDurationSecs, ack: true });
    await this.deps.adapter.setStateAsync("automation.activePlan", { val: (_b = this.activePlanName) != null ? _b : "", ack: true });
    await this.deps.adapter.setStateAsync("automation.currentValve", {
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
