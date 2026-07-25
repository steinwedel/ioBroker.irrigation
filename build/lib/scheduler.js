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
var scheduler_exports = {};
__export(scheduler_exports, {
  Scheduler: () => Scheduler,
  resolvePlanFromIcalTitle: () => resolvePlanFromIcalTitle
});
module.exports = __toCommonJS(scheduler_exports);
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
class Scheduler {
  deps;
  timerHandles = [];
  lastCheckedMinute = -1;
  icalTriggerSubscribed = false;
  constructor(deps) {
    this.deps = deps;
  }
  async init() {
    const handle = this.deps.adapter.setInterval(() => {
      this.checkTimers().catch(
        (error) => this.deps.adapter.log.error(`Scheduler tick failed: ${error.message}`)
      );
    }, 1e3);
    this.timerHandles.push(handle);
    const icalState = this.deps.getConfig().scheduler.icalTriggerState;
    if (icalState) {
      await this.deps.adapter.subscribeForeignStatesAsync(icalState);
      this.icalTriggerSubscribed = true;
    }
  }
  destroy() {
    for (const handle of this.timerHandles) {
      this.deps.adapter.clearInterval(handle);
    }
    this.timerHandles = [];
  }
  async checkTimers() {
    var _a, _b;
    const now = /* @__PURE__ */ new Date();
    const minuteKey = now.getHours() * 60 + now.getMinutes();
    if (minuteKey === this.lastCheckedMinute) {
      return;
    }
    this.lastCheckedMinute = minuteKey;
    const config = this.deps.getConfig();
    if (!config.scheduler.autoMode) {
      return;
    }
    if (this.deps.isSeasonBlocked() || this.deps.isFrostBlocked()) {
      return;
    }
    const nowStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
    for (const timeStr of config.scheduler.timerTimes) {
      if (!TIME_RE.test(timeStr.trim())) {
        continue;
      }
      if (normalizeTime(timeStr) === normalizeTime(nowStr)) {
        const planName = (_b = (_a = config.plans[0]) == null ? void 0 : _a.name) != null ? _b : "All";
        await this.deps.onTrigger(planName, "timer");
      }
    }
  }
  /**
   * Called from main.ts's onStateChange for foreign state subscriptions.
   * Resolves the plan name from the ical event title, defaulting to the
   * configured prefix's plan if no specific plan name is found in the title.
   *
   * @param id
   * @param state
   */
  async onForeignStateChange(id, state) {
    var _a, _b;
    const config = this.deps.getConfig();
    if (id !== config.scheduler.icalTriggerState) {
      return false;
    }
    if ((state == null ? void 0 : state.val) !== true) {
      return true;
    }
    if (this.deps.isSeasonBlocked() || this.deps.isFrostBlocked()) {
      this.deps.adapter.log.info("iCal trigger fired but season/frost block is active - ignored.");
      return true;
    }
    const planName = (_b = (_a = config.plans[0]) == null ? void 0 : _a.name) != null ? _b : "All";
    await this.deps.onTrigger(planName, "ical");
    return true;
  }
  async resubscribeIcal(newState) {
    if (this.icalTriggerSubscribed) {
      const oldState = this.deps.getConfig().scheduler.icalTriggerState;
      if (oldState) {
        await this.deps.adapter.unsubscribeForeignStatesAsync(oldState);
      }
    }
    if (newState) {
      await this.deps.adapter.subscribeForeignStatesAsync(newState);
      this.icalTriggerSubscribed = true;
    }
  }
}
function normalizeTime(value) {
  const match = TIME_RE.exec(value.trim());
  if (!match) {
    return value.trim();
  }
  return `${parseInt(match[1], 10)}:${match[2]}`;
}
function resolvePlanFromIcalTitle(title, prefix, planNames, defaultPlan) {
  const trimmed = title.trim();
  const prefixLower = prefix.toLowerCase();
  if (!trimmed.toLowerCase().startsWith(prefixLower)) {
    return defaultPlan;
  }
  let rest = trimmed.substring(prefix.length).trim();
  rest = rest.replace(/^[:\-–]\s*/, "").trim();
  if (!rest) {
    return defaultPlan;
  }
  const match = planNames.find((name) => name.toLowerCase() === rest.toLowerCase());
  return match != null ? match : defaultPlan;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Scheduler,
  resolvePlanFromIcalTitle
});
//# sourceMappingURL=scheduler.js.map
