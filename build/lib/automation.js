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
  buildBatches: () => buildBatches
});
module.exports = __toCommonJS(automation_exports);
function buildBatches(zoneIndexes, zones, pumpCapacity) {
  if (pumpCapacity <= 0) {
    return zoneIndexes.map((idx) => [idx]);
  }
  const sorted = [...zoneIndexes].sort((a, b) => zones[b].duration - zones[a].duration);
  const batches = [];
  for (const zoneIdx of sorted) {
    const zone = zones[zoneIdx];
    const flowRate = zone.flowRate || 0;
    let bestBatch;
    let bestIncrease = Infinity;
    for (const batch of batches) {
      if (batch.flowSum + flowRate > pumpCapacity) {
        continue;
      }
      const increase = Math.max(0, zone.duration - batch.duration);
      if (increase < bestIncrease) {
        bestIncrease = increase;
        bestBatch = batch;
      }
    }
    if (bestBatch) {
      bestBatch.zoneIdxs.push(zoneIdx);
      bestBatch.flowSum += flowRate;
      bestBatch.duration = Math.max(bestBatch.duration, zone.duration);
    } else {
      batches.push({ zoneIdxs: [zoneIdx], flowSum: flowRate, duration: zone.duration });
    }
  }
  return batches.map((b) => b.zoneIdxs);
}
class AutomationEngine {
  deps;
  status = "idle";
  pauseReason = null;
  activePlanName = null;
  batches = [];
  currentBatchIndex = -1;
  runningZones = /* @__PURE__ */ new Set();
  zoneEndsAt = /* @__PURE__ */ new Map();
  zoneDurationSecs = /* @__PURE__ */ new Map();
  inBatchPause = false;
  batchPauseEndsAt = 0;
  totalDurationMin = 0;
  startedAtMs = 0;
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
   * Called once at adapter start. If the persisted automation state claims
   * a run was in progress, all valves are closed defensively and the
   * automation is reset to idle - see plan "Config-Änderung während
   * Laufzeit" / risk "Compact Mode".
   */
  async recoverAfterRestart() {
    for (const valve of this.deps.valves) {
      await valve.stop();
    }
    this.status = "idle";
    this.pauseReason = null;
    this.activePlanName = null;
    this.batches = [];
    this.currentBatchIndex = -1;
    this.runningZones.clear();
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
      this.deps.adapter.log.warn(`Run request (${source}) ignored: manual zone run in progress.`);
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
    const activeZoneIndexes = this.buildActiveZoneList(config, plan.groups);
    if (activeZoneIndexes.length === 0) {
      this.deps.adapter.log.warn(`No active zones for plan "${planName}" today.`);
      await this.deps.adapter.setStateAsync("automation.status", {
        val: `Mode: idle (keine aktiven Zonen heute f\xFCr Plan "${planName}")`,
        ack: true
      });
      return;
    }
    this.activePlanName = plan.name;
    await this.deps.adapter.setStateAsync("automation.planSelect", { val: plan.name, ack: true });
    this.batches = buildBatches(activeZoneIndexes, config.zones, config.scheduler.pumpCapacity);
    this.currentBatchIndex = -1;
    this.totalDurationMin = this.computeTotalDurationMin(config);
    this.startedAtMs = Date.now();
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
  /**
   * Zones belonging to the plan's groups, filtered by enabled/day/sensors. See plan buildActiveBeete() equivalent.
   *
   * @param config
   * @param planGroups
   */
  buildActiveZoneList(config, planGroups) {
    const weekday = (/* @__PURE__ */ new Date()).getDay();
    const result = [];
    for (let i = 0; i < config.zones.length; i++) {
      const zone = config.zones[i];
      if (!zone.enabled) {
        continue;
      }
      if (zone.valveIndex < 0 || zone.valveIndex >= config.valves.length) {
        continue;
      }
      if (zone.days.length > 0 && !zone.days.includes(weekday)) {
        continue;
      }
      if (planGroups.length > 0 && !zone.groups.some((g) => planGroups.includes(g))) {
        continue;
      }
      const blocked = this.deps.isZoneBlockedForAutoRun(i);
      if (blocked.blocked) {
        this.deps.adapter.log.debug(`Zone ${zone.name} skipped: ${blocked.reason}`);
        continue;
      }
      result.push(i);
    }
    return result;
  }
  computeTotalDurationMin(config) {
    let total = 0;
    for (const batch of this.batches) {
      const batchDuration = Math.max(...batch.map((idx) => this.effectiveDuration(config, idx)));
      total += batchDuration;
    }
    if (config.scheduler.zonePause > 0 && this.batches.length > 1) {
      total += config.scheduler.zonePause * (this.batches.length - 1);
    }
    return total;
  }
  effectiveDuration(config, zoneIndex) {
    return config.zones[zoneIndex].duration * config.scheduler.extensionFactor;
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
    this.runningZones = new Set(batch);
    this.inBatchPause = false;
    for (const zoneIndex of batch) {
      const zone = config.zones[zoneIndex];
      const durationSecs = Math.round(this.effectiveDuration(config, zoneIndex) * 60);
      this.zoneDurationSecs.set(zoneIndex, durationSecs);
      this.zoneEndsAt.set(zoneIndex, Date.now() + durationSecs * 1e3);
      await this.deps.valves[zone.valveIndex].start(durationSecs);
      (_b = (_a = this.deps).onZoneFlowChange) == null ? void 0 : _b.call(_a, zoneIndex, true);
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
    this.runningZones.clear();
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
    const stillRunning = [...this.runningZones].filter((idx) => {
      var _a2;
      return Date.now() < ((_a2 = this.zoneEndsAt.get(idx)) != null ? _a2 : 0);
    });
    if (stillRunning.length !== this.runningZones.size) {
      for (const idx of this.runningZones) {
        if (!stillRunning.includes(idx)) {
          (_b = (_a = this.deps).onZoneFlowChange) == null ? void 0 : _b.call(_a, idx, false);
        }
      }
      this.runningZones = new Set(stillRunning);
    }
    if (this.runningZones.size === 0) {
      const config = this.deps.getConfig();
      if (config.scheduler.zonePause > 0 && this.currentBatchIndex < this.batches.length - 1) {
        this.inBatchPause = true;
        this.batchPauseEndsAt = Date.now() + config.scheduler.zonePause * 60 * 1e3;
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
      return;
    }
    if (this.status === "idle") {
      return;
    }
    for (const idx of this.runningZones) {
      const config = this.deps.getConfig();
      await this.deps.valves[config.zones[idx].valveIndex].stop();
      (_b = (_a = this.deps).onZoneFlowChange) == null ? void 0 : _b.call(_a, idx, false);
    }
    this.runningZones.clear();
    await this.finishRun();
  }
  async pause() {
    var _a;
    if (this.manualRun) {
      return;
    }
    if (this.status === "running") {
      for (const idx of this.runningZones) {
        const config = this.deps.getConfig();
        await this.deps.valves[config.zones[idx].valveIndex].stop();
      }
      this.status = "paused";
      this.pauseReason = "manual";
      await this.publishStatus();
    } else if (this.status === "paused") {
      if (this.pauseReason === "legalRestriction" && this.deps.isLegallyRestricted()) {
        this.deps.adapter.log.warn("Resume refused: legal restriction still active.");
        return;
      }
      this.status = "running";
      this.pauseReason = null;
      const config = this.deps.getConfig();
      for (const idx of this.runningZones) {
        const remaining = Math.max(0, Math.round((((_a = this.zoneEndsAt.get(idx)) != null ? _a : 0) - Date.now()) / 1e3));
        await this.deps.valves[config.zones[idx].valveIndex].start(remaining);
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
    for (const idx of this.runningZones) {
      const config = this.deps.getConfig();
      await this.deps.valves[config.zones[idx].valveIndex].stop();
      (_b = (_a = this.deps).onZoneFlowChange) == null ? void 0 : _b.call(_a, idx, false);
    }
    this.runningZones.clear();
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
    for (const idx of this.runningZones) {
      const config = this.deps.getConfig();
      await this.deps.valves[config.zones[idx].valveIndex].stop();
      (_b = (_a = this.deps).onZoneFlowChange) == null ? void 0 : _b.call(_a, idx, false);
    }
    this.runningZones.clear();
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
  // Manual single-zone runs
  // ------------------------------------------------------------------
  async manualStartZone(zoneIndex) {
    var _a, _b;
    if (this.manualRun) {
      this.deps.adapter.log.warn("Manual zone start ignored: another manual run is already active.");
      return;
    }
    const config = this.deps.getConfig();
    const zone = config.zones[zoneIndex];
    if (!zone || zone.valveIndex < 0 || zone.valveIndex >= config.valves.length) {
      this.deps.adapter.log.error(`Manual start for zone ${zoneIndex} failed: invalid valve reference.`);
      return;
    }
    this.wasAutomationPausedForManual = false;
    if (this.status === "running") {
      for (const idx of this.runningZones) {
        await this.deps.valves[config.zones[idx].valveIndex].stop();
      }
      this.wasAutomationBatchIndexBeforeManual = this.currentBatchIndex;
      this.status = "paused";
      this.pauseReason = "manual";
      this.wasAutomationPausedForManual = true;
    }
    const durationSecs = Math.round(zone.manualDuration * 60);
    this.manualRun = { zoneIndex, endsAt: Date.now() + durationSecs * 1e3 };
    await this.deps.valves[zone.valveIndex].start(durationSecs);
    (_b = (_a = this.deps).onZoneFlowChange) == null ? void 0 : _b.call(_a, zoneIndex, true);
    await this.publishStatus();
  }
  async finishManualRun() {
    var _a, _b;
    if (!this.manualRun) {
      return;
    }
    const config = this.deps.getConfig();
    const zone = config.zones[this.manualRun.zoneIndex];
    if (zone) {
      await this.deps.valves[zone.valveIndex].stop();
      (_b = (_a = this.deps).onZoneFlowChange) == null ? void 0 : _b.call(_a, this.manualRun.zoneIndex, false);
    }
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
    const config = this.deps.getConfig();
    const zone = config.zones[this.manualRun.zoneIndex];
    if (zone) {
      await this.deps.valves[zone.valveIndex].stop();
      (_b = (_a = this.deps).onZoneFlowChange) == null ? void 0 : _b.call(_a, this.manualRun.zoneIndex, false);
    }
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
        for (const idx of this.runningZones) {
          const config = this.deps.getConfig();
          await this.deps.valves[config.zones[idx].valveIndex].stop();
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
          const config = this.deps.getConfig();
          for (const idx of this.runningZones) {
            const remaining = Math.max(
              0,
              Math.round((((_a = this.zoneEndsAt.get(idx)) != null ? _a : 0) - Date.now()) / 1e3)
            );
            await this.deps.valves[config.zones[idx].valveIndex].start(remaining);
          }
          await this.publishStatus();
        }
      }
    }
  }
  // ------------------------------------------------------------------
  // Status text
  // ------------------------------------------------------------------
  async publishStatus() {
    var _a, _b;
    const config = this.deps.getConfig();
    let text = `Mode: ${this.status}`;
    if (this.manualRun) {
      const zone = config.zones[this.manualRun.zoneIndex];
      const remainingSecs = Math.max(0, Math.round((this.manualRun.endsAt - Date.now()) / 1e3));
      text = `Mode: manual (${(_a = zone == null ? void 0 : zone.name) != null ? _a : this.manualRun.zoneIndex}, noch ${Math.ceil(remainingSecs / 60)}min)`;
    } else if (this.status !== "idle" && this.activePlanName) {
      text += ` (Plan: ${this.activePlanName})`;
      if (this.pauseReason === "legalRestriction") {
        text += " (gesetzliche Beregnungssperre aktiv)";
      }
      if (this.inBatchPause) {
        const remaining = Math.max(0, Math.round((this.batchPauseEndsAt - Date.now()) / 1e3 / 60));
        text += ` - Pause (Versickerung), noch ${remaining}min`;
      } else if (this.runningZones.size > 0) {
        const zoneNames = [...this.runningZones].map((idx) => {
          var _a2, _b2, _c;
          const remaining = Math.max(
            0,
            Math.round((((_a2 = this.zoneEndsAt.get(idx)) != null ? _a2 : 0) - Date.now()) / 1e3 / 60)
          );
          return `${(_c = (_b2 = config.zones[idx]) == null ? void 0 : _b2.name) != null ? _c : idx} (${remaining}min)`;
        }).join(", ");
        text += ` - Batch ${this.currentBatchIndex + 1}/${this.batches.length}: ${zoneNames}`;
      }
    }
    await this.deps.adapter.setStateAsync("automation.status", { val: text, ack: true });
    await this.deps.adapter.setStateAsync("automation.running", {
      val: this.status === "running" || this.status === "paused" || this.manualRun !== null,
      ack: true
    });
    const elapsedMin = this.startedAtMs > 0 ? Math.floor((Date.now() - this.startedAtMs) / 6e4) : 0;
    await this.deps.adapter.setStateAsync("automation.elapsedTime", { val: elapsedMin, ack: true });
    await this.deps.adapter.setStateAsync("automation.remainingTime", {
      val: Math.max(0, this.totalDurationMin - elapsedMin),
      ack: true
    });
    await this.deps.adapter.setStateAsync("automation.totalDuration", { val: this.totalDurationMin, ack: true });
    await this.deps.adapter.setStateAsync("automation.activePlan", { val: (_b = this.activePlanName) != null ? _b : "", ack: true });
    await this.deps.adapter.setStateAsync("automation.currentZone", {
      val: this.runningZones.size > 0 ? [...this.runningZones][0] : -1,
      ack: true
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AutomationEngine,
  buildBatches
});
//# sourceMappingURL=automation.js.map
