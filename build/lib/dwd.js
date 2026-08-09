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
const FETCH_TIMEOUT_MS = 15e3;
const MAX_TEMP_AGE_CHECK_MULTIPLIER = 3;
const DEFAULT_MAX_TEMP_AGE_MS = 6 * 60 * 60 * 1e3;
function annualDayOfYear(month, day) {
  return Math.floor((Date.UTC(2e3, month - 1, day) - Date.UTC(2e3, 0, 1)) / 864e5);
}
function parseAnnualDate(value) {
  const match = /^(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])$/.exec(value);
  if (!match) {
    return void 0;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (day > new Date(2e3, month, 0).getDate()) {
    return void 0;
  }
  return annualDayOfYear(month, day);
}
function parseTime(value) {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(value);
  if (!match) {
    return void 0;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}
function isRestrictionEnabled(config) {
  return config.legalRestriction.enabled && config.scheduler.autoMode;
}
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
    const checkIntervalMinutes = Number.isFinite(config.legalRestriction.checkInterval) ? config.legalRestriction.checkInterval : 10;
    const intervalMs = Math.max(1, checkIntervalMinutes) * 60 * 1e3;
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
    const hasDateRange = Boolean(config.startDate || config.endDate);
    const hasTimeRange = Boolean(config.startTime || config.endTime);
    const startDate = parseAnnualDate(config.startDate);
    const endDate = parseAnnualDate(config.endDate);
    const startTime = parseTime(config.startTime);
    const endTime = parseTime(config.endTime);
    if (hasDateRange && (startDate === void 0 || endDate === void 0)) {
      this.deps.adapter.log.error(
        `Legal restriction date range is invalid (startDate="${config.startDate}", endDate="${config.endDate}"); expected format D.M, e.g. "1.6" or "01.06". Restriction cannot be evaluated.`
      );
      return false;
    }
    if (hasTimeRange && (startTime === void 0 || endTime === void 0)) {
      this.deps.adapter.log.error(
        `Legal restriction time range is invalid (startTime="${config.startTime}", endTime="${config.endTime}"); expected format HH:MM. Restriction cannot be evaluated.`
      );
      return false;
    }
    const currentDate = annualDayOfYear(now.getMonth() + 1, now.getDate());
    const currentTime = now.getHours() * 60 + now.getMinutes();
    const isWithinDateRange = !hasDateRange || (startDate <= endDate ? currentDate >= startDate && currentDate <= endDate : currentDate >= startDate || currentDate <= endDate);
    const isWithinTimeRange = !hasTimeRange || (startTime <= endTime ? currentTime >= startTime && currentTime <= endTime : currentTime >= startTime || currentTime <= endTime);
    return isWithinDateRange && isWithinTimeRange;
  }
  async check() {
    const config = this.deps.getConfig();
    if (!isRestrictionEnabled(config)) {
      await this.apply(false);
      return false;
    }
    if (!this.isWithinWindow(/* @__PURE__ */ new Date())) {
      await this.apply(false);
      return false;
    }
    const temperatureStateId = config.legalRestriction.temperatureStateId.trim();
    if (temperatureStateId) {
      const temp2 = await this.fetchLocalTemperature(temperatureStateId);
      return this.applyTemperature(temp2);
    }
    if (!config.legalRestriction.stationId.trim()) {
      await this.apply(true);
      return true;
    }
    const temp = await this.fetchTemperature(config.legalRestriction.stationId);
    return this.applyTemperature(temp);
  }
  async onForeignStateChange(id, state) {
    const config = this.deps.getConfig();
    if (id !== config.legalRestriction.temperatureStateId.trim()) {
      return false;
    }
    if (!isRestrictionEnabled(config) || !this.isWithinWindow(/* @__PURE__ */ new Date())) {
      await this.apply(false);
      return true;
    }
    const temp = typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val) ? state.val : null;
    if (temp === null) {
      await this.recordTemperatureError("Local temperature state has no valid numeric value");
      return true;
    }
    await this.recordTemperature(temp);
    await this.apply(temp >= config.legalRestriction.minTemperature);
    return true;
  }
  async applyTemperature(temp) {
    if (temp === null) {
      return this.active;
    }
    const restricted = temp >= this.deps.getConfig().legalRestriction.minTemperature;
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
  async fetchLocalTemperature(stateId) {
    try {
      const state = await this.deps.adapter.getForeignStateAsync(stateId);
      const temp = typeof (state == null ? void 0 : state.val) === "number" && Number.isFinite(state.val) ? state.val : null;
      if (temp === null) {
        throw new Error("Local temperature state has no valid numeric value");
      }
      await this.recordTemperature(temp);
      return temp;
    } catch (error) {
      const message = error.message;
      this.deps.adapter.log.warn(`Local temperature read failed: ${message}`);
      await this.recordTemperatureError(message);
      return null;
    }
  }
  async fetchTemperature(stationId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${DWD_URL_BASE}${stationId}-BEOB.csv`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const csv = await response.text();
      const temp = parseDwdTemperature(csv);
      if (temp === null) {
        throw new Error("Temperature column not found or unparsable in DWD CSV");
      }
      await this.recordTemperature(temp);
      await this.deps.adapter.setStateAsync("info.connection", { val: true, ack: true });
      return temp;
    } catch (error) {
      const isAbort = error.name === "AbortError";
      const message = isAbort ? `Request timed out after ${FETCH_TIMEOUT_MS / 1e3}s` : error.message;
      this.deps.adapter.log.warn(`DWD temperature fetch failed: ${message}`);
      await this.recordTemperatureError(message);
      await this.deps.adapter.setStateAsync("info.connection", { val: false, ack: true });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
  getMaxTempAgeMs() {
    const config = this.deps.getConfig().legalRestriction;
    if (!Number.isFinite(config.checkInterval) || config.checkInterval <= 0) {
      return DEFAULT_MAX_TEMP_AGE_MS;
    }
    return config.checkInterval * 60 * 1e3 * MAX_TEMP_AGE_CHECK_MULTIPLIER;
  }
  async checkTemperatureAge() {
    var _a, _b;
    const state = await ((_b = (_a = this.deps.adapter).getStateAsync) == null ? void 0 : _b.call(_a, "legalRestriction.currentTempTs"));
    const ts = typeof (state == null ? void 0 : state.val) === "number" ? state.val : void 0;
    if (ts === void 0) {
      return;
    }
    const maxAgeMs = this.getMaxTempAgeMs();
    const ageMs = Date.now() - ts;
    if (ageMs > maxAgeMs) {
      this.deps.adapter.log.warn(
        `Legal restriction: last successful temperature reading is ${Math.round(ageMs / 6e4)} minutes old (threshold ${Math.round(maxAgeMs / 6e4)} minutes). Restriction decisions may be based on stale data.`
      );
    }
  }
  async recordTemperature(temp) {
    await this.deps.adapter.setStateAsync("legalRestriction.currentTemp", { val: temp, ack: true });
    await this.deps.adapter.setStateAsync("legalRestriction.currentTempTs", { val: Date.now(), ack: true });
    await this.deps.adapter.setStateAsync("legalRestriction.lastCheckError", { val: "", ack: true });
  }
  async recordTemperatureError(message) {
    await this.deps.adapter.setStateAsync("legalRestriction.lastCheckError", { val: message, ack: true });
    await this.checkTemperatureAge();
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
