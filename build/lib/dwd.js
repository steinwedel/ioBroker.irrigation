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
var dwd_exports = {};
__export(dwd_exports, {
  DwdRestriction: () => DwdRestriction,
  parseDwdTemperature: () => parseDwdTemperature
});
module.exports = __toCommonJS(dwd_exports);
const DWD_URL_BASE = "https://opendata.dwd.de/weather/weather_reports/poi/";
class DwdRestriction {
  deps;
  checkTimer;
  active = false;
  constructor(deps) {
    this.deps = deps;
  }
  isActive() {
    return this.active;
  }
  async init() {
    const config = this.deps.getConfig();
    await this.deps.adapter.setStateAsync("legalRestriction.enabled", {
      val: config.legalRestriction.enabled,
      ack: true
    });
    if (!config.legalRestriction.enabled) {
      return;
    }
    const intervalMs = Math.max(1, config.legalRestriction.checkInterval) * 60 * 1e3;
    this.checkTimer = this.deps.adapter.setInterval(() => {
      this.check().catch(
        (error) => this.deps.adapter.log.error(`Legal restriction check failed: ${error.message}`)
      );
    }, intervalMs);
    await this.check();
  }
  destroy() {
    if (this.checkTimer) {
      this.deps.adapter.clearInterval(this.checkTimer);
      this.checkTimer = void 0;
    }
  }
  isWithinWindow(now) {
    const config = this.deps.getConfig().legalRestriction;
    const month = now.getMonth() + 1;
    const hour = now.getHours();
    if (month < config.monthStart || month > config.monthEnd) {
      return false;
    }
    if (hour < config.hourStart || hour >= config.hourEnd) {
      return false;
    }
    return true;
  }
  async check() {
    const config = this.deps.getConfig();
    if (!config.legalRestriction.enabled) {
      await this.apply(false);
      return false;
    }
    if (!this.isWithinWindow(/* @__PURE__ */ new Date())) {
      await this.apply(false);
      return false;
    }
    if (!config.legalRestriction.stationId.trim()) {
      await this.apply(true);
      return true;
    }
    const temp = await this.fetchTemperature(config.legalRestriction.stationId);
    if (temp === null) {
      return this.active;
    }
    const restricted = temp >= config.legalRestriction.minTemperature;
    await this.apply(restricted);
    return restricted;
  }
  async apply(restricted) {
    const wasActive = this.active;
    this.active = restricted;
    await this.deps.adapter.setStateAsync("legalRestriction.active", { val: restricted, ack: true });
    if (restricted !== wasActive) {
      await this.deps.onRestrictionChanged(restricted);
    }
  }
  async fetchTemperature(stationId) {
    try {
      const response = await fetch(`${DWD_URL_BASE}${stationId}-BEOB.csv`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const csv = await response.text();
      const temp = parseDwdTemperature(csv);
      if (temp === null) {
        throw new Error("Temperature column not found or unparsable in DWD CSV");
      }
      await this.deps.adapter.setStateAsync("legalRestriction.currentTemp", { val: temp, ack: true });
      await this.deps.adapter.setStateAsync("legalRestriction.currentTempTs", { val: Date.now(), ack: true });
      await this.deps.adapter.setStateAsync("legalRestriction.lastCheckError", { val: "", ack: true });
      return temp;
    } catch (error) {
      const message = error.message;
      this.deps.adapter.log.warn(`DWD temperature fetch failed: ${message}`);
      await this.deps.adapter.setStateAsync("legalRestriction.lastCheckError", { val: message, ack: true });
      return null;
    }
  }
}
function parseDwdTemperature(csv) {
  if (!csv) {
    return null;
  }
  const lines = csv.split("\n");
  if (lines.length < 4) {
    return null;
  }
  const headerCols = lines[2].trim().split(";");
  const tempColumnIndex = headerCols.indexOf("Temperatur (2m)");
  if (tempColumnIndex === -1) {
    return null;
  }
  const dataLine = lines[3].trim();
  if (!dataLine) {
    return null;
  }
  const cols = dataLine.split(";");
  if (cols.length <= tempColumnIndex) {
    return null;
  }
  const raw = cols[tempColumnIndex].trim().replace(",", ".");
  if (raw === "" || raw === "---") {
    return null;
  }
  const temp = parseFloat(raw);
  return isNaN(temp) ? null : temp;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DwdRestriction,
  parseDwdTemperature
});
//# sourceMappingURL=dwd.js.map
