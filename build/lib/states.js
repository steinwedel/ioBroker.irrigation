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
var states_exports = {};
__export(states_exports, {
  applyConfigToStates: () => applyConfigToStates,
  createBaseStates: () => createBaseStates
});
module.exports = __toCommonJS(states_exports);
async function createBaseStates(adapter) {
  await setObj(adapter, "scan.progress", {
    name: "Auto-discovery scan progress",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "automation.active", {
    name: "Automatic mode enabled",
    type: "boolean",
    role: "switch",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.triggerMode", {
    name: "Automatic trigger mode (timer/ical)",
    type: "string",
    role: "text",
    states: { timer: "timer", ical: "ical" },
    read: true,
    write: false,
    def: "timer"
  });
  await setObj(adapter, "automation.pauseOnRain", {
    name: "Pause automatic watering when raining",
    type: "boolean",
    role: "switch",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.rainHysteresisMinutes", {
    name: "Rain resume hysteresis",
    type: "number",
    role: "value",
    unit: "min",
    read: true,
    write: false,
    def: 10
  });
  await setObj(adapter, "automation.windPauseEnabled", {
    name: "Pause automatic watering when windy",
    type: "boolean",
    role: "switch",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.windSpeedStateId", {
    name: "Wind speed state id",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "automation.windSpeedLimit", {
    name: "Wind speed limit",
    type: "number",
    role: "value",
    unit: "km/h",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "automation.windGustStateId", {
    name: "Wind gust state id",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "automation.windGustLimit", {
    name: "Wind gust limit",
    type: "number",
    role: "value",
    unit: "km/h",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "automation.windHysteresisMinutes", {
    name: "Wind resume hysteresis",
    type: "number",
    role: "value",
    unit: "min",
    read: true,
    write: false,
    def: 10
  });
  await setObj(adapter, "automation.running", {
    name: "Automation running",
    type: "boolean",
    role: "indicator.working",
    read: true,
    write: false,
    def: false
  });
  await setObj(adapter, "automation.status", {
    name: "Status text",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: "Mode: idle"
  });
  await setObj(adapter, "automation.start", {
    name: "Start automation",
    type: "boolean",
    role: "button",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.startPlan", {
    name: "Start selected plan",
    type: "string",
    role: "text",
    read: true,
    write: true,
    def: ""
  });
  await setObj(adapter, "automation.stop", {
    name: "Stop automation",
    type: "boolean",
    role: "button.stop",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.pause", {
    name: "Pause/resume automation",
    type: "boolean",
    role: "button",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.next", {
    name: "Skip to next step",
    type: "boolean",
    role: "button",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.back", {
    name: "Repeat previous step",
    type: "boolean",
    role: "button",
    read: true,
    write: true,
    def: false
  });
  await adapter.delObjectAsync("automation.currentZone").catch(() => void 0);
  await setObj(adapter, "automation.currentValve", {
    name: "Current valve index (sequential fallback)",
    type: "number",
    role: "value",
    read: true,
    write: false,
    def: -1
  });
  await setObj(adapter, "automation.currentBatch", {
    name: "Current batch (1-based)",
    type: "number",
    role: "value",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "automation.totalBatches", {
    name: "Total batches",
    type: "number",
    role: "value",
    read: true,
    write: false,
    def: 0
  });
  await adapter.delObjectAsync("automation.batchZones").catch(() => void 0);
  await setObj(adapter, "automation.batchValves", {
    name: "Valve indexes in the current batch",
    type: "string",
    role: "json",
    read: true,
    write: false,
    def: "[]"
  });
  await setObj(adapter, "automation.totalDuration", {
    name: "Total planned duration",
    type: "number",
    role: "value",
    unit: "s",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "automation.elapsedTime", {
    name: "Elapsed time",
    type: "number",
    role: "value",
    unit: "s",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "automation.remainingDuration", {
    name: "Remaining duration",
    type: "number",
    role: "value",
    unit: "s",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "automation.remainingDurationMin", {
    name: "Remaining time (mm:ss)",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: "00:00"
  });
  await adapter.extendObjectAsync("automation.totalDuration", { common: { role: "value", unit: "s" } });
  await adapter.extendObjectAsync("automation.elapsedTime", { common: { role: "value", unit: "s" } });
  await adapter.extendObjectAsync("automation.remainingDuration", { common: { role: "value", unit: "s" } });
  await adapter.delObjectAsync("automation.remainingTime").catch(() => void 0);
  await setObj(adapter, "automation.activePlan", {
    name: "Active plan name",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "automation.planSelect", {
    name: "Plan selection for next start",
    type: "string",
    role: "text",
    read: true,
    write: true,
    def: "All"
  });
  await setObj(adapter, "automation.temperatureAdjustmentEnabled", {
    name: "Temperature-controlled irrigation adjustment enabled",
    type: "boolean",
    role: "switch",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.temperatureAdjustmentStateId", {
    name: "Temperature adjustment state id",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await adapter.extendObjectAsync("automation.temperatureAdjustmentStateId", { common: { write: false } });
  await setObj(adapter, "automation.temperatureAdjustmentFactor", {
    name: "Temperature adjustment factor for current run",
    type: "number",
    role: "value",
    read: true,
    write: false,
    def: 1
  });
  await setObj(adapter, "automation.pumpCapacity", {
    name: "Pump capacity",
    type: "number",
    role: "value",
    unit: "l/min",
    read: true,
    write: true,
    def: 0
  });
  await setObj(adapter, "automation.seasonEnabled", {
    name: "Season pause enabled",
    type: "boolean",
    role: "switch",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.seasonStart", {
    name: "Season start month",
    type: "number",
    role: "value",
    min: 1,
    max: 12,
    read: true,
    write: true,
    def: 4
  });
  await setObj(adapter, "automation.seasonEnd", {
    name: "Season end month",
    type: "number",
    role: "value",
    min: 1,
    max: 12,
    read: true,
    write: true,
    def: 10
  });
  await setObj(adapter, "automation.valvePause", {
    name: "Pause between batches",
    type: "number",
    role: "value",
    unit: "min",
    read: true,
    write: true,
    def: 0
  });
  await setObj(adapter, "automation.frostEnabled", {
    name: "Frost protection enabled",
    type: "boolean",
    role: "switch",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "automation.frostMinTemp", {
    name: "Frost protection minimum temperature",
    type: "number",
    role: "value.temperature",
    unit: "\xB0C",
    read: true,
    write: true,
    def: 2
  });
  await setObj(adapter, "automation.plansList", {
    name: "Available plan names",
    type: "string",
    role: "json",
    read: true,
    write: false,
    def: "[]"
  });
  await setObj(adapter, "automation.plansData", {
    name: "Plan configuration (internal)",
    desc: "Full plan configuration (name + assigned valve indexes per plan), stored here instead of in the adapter instance config so that adding/editing/deleting plans from the admin UI does not restart the adapter (writing native config always restarts the adapter instance). Not meant for external use - use automation.plansList for the plan names.",
    type: "string",
    role: "json",
    read: true,
    write: false,
    def: "[]"
  });
  await setObj(adapter, "sensors.rain", {
    name: "Rain detected",
    type: "boolean",
    role: "sensor.rain",
    read: true,
    write: false,
    def: false
  });
  await setObj(adapter, "sensors.rainId", {
    name: "Rain sensor state id",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "sensors.soilMoisture", {
    name: "Soil moisture",
    type: "number",
    role: "value.humidity",
    unit: "%",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "sensors.soilMoistureId", {
    name: "Soil moisture sensor state id",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "sensors.temperature", {
    name: "Temperature",
    type: "number",
    role: "value.temperature",
    unit: "\xB0C",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "sensors.temperatureId", {
    name: "Temperature sensor state id",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "weather.enabled", {
    name: "Weather API enabled",
    type: "boolean",
    role: "switch",
    read: true,
    write: false,
    def: false
  });
  await setObj(adapter, "weather.temperature", {
    name: "Weather API temperature",
    type: "number",
    role: "value.temperature",
    unit: "\xB0C",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "weather.precipitationChance", {
    name: "Precipitation chance",
    type: "number",
    role: "value.precipitation.chance",
    unit: "%",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "weather.precipitation", {
    name: "Precipitation",
    type: "number",
    role: "value.precipitation",
    unit: "mm",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "weather.lastUpdate", {
    name: "Last weather update",
    type: "number",
    role: "value.time",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "legalRestriction.enabled", {
    name: "Legal restriction check enabled",
    type: "boolean",
    role: "switch",
    read: true,
    write: false,
    def: false
  });
  await setObj(adapter, "legalRestriction.active", {
    name: "Legal restriction currently active",
    type: "boolean",
    role: "indicator.alarm",
    read: true,
    write: false,
    def: false
  });
  await setObj(adapter, "legalRestriction.stationId", {
    name: "DWD station id",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: "10400"
  });
  await setObj(adapter, "legalRestriction.temperatureStateId", {
    name: "Local temperature state id",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "legalRestriction.startDate", {
    name: "Restriction start date",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: "1.6"
  });
  await setObj(adapter, "legalRestriction.endDate", {
    name: "Restriction end date",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: "30.9"
  });
  await setObj(adapter, "legalRestriction.startTime", {
    name: "Restriction start time",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: "11:00"
  });
  await setObj(adapter, "legalRestriction.endTime", {
    name: "Restriction end time",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: "17:00"
  });
  await setObj(adapter, "legalRestriction.minTemperature", {
    name: "Restriction minimum temperature",
    type: "number",
    role: "value.temperature",
    unit: "\xB0C",
    read: true,
    write: false,
    def: 27
  });
  await setObj(adapter, "legalRestriction.currentTemp", {
    name: "Last checked restriction temperature",
    type: "number",
    role: "value.temperature",
    unit: "\xB0C",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "legalRestriction.currentTempTs", {
    name: "Timestamp of last temperature check",
    type: "number",
    role: "value.time",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "legalRestriction.lastCheckError", {
    name: "Last temperature check error",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "watchdog.lastIssue", {
    name: "Last watchdog issue",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
  await setObj(adapter, "watchdog.lastIssueTs", {
    name: "Timestamp of last watchdog issue",
    type: "number",
    role: "value.time",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "watchdog.issueCount", {
    name: "Total watchdog issue count",
    type: "number",
    role: "value",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "watchdog.flowActive", {
    name: "Flow leak detected",
    type: "boolean",
    role: "indicator.alarm",
    read: true,
    write: false,
    def: false
  });
  await adapter.extendObjectAsync("watchdog.flowActive", { common: { role: "indicator.alarm" } });
  await setObj(adapter, "watchdog.flowDeviationValve", {
    name: "Valve with flow deviation",
    type: "number",
    role: "value",
    read: true,
    write: false,
    def: -1
  });
  await setObj(adapter, "watchdog.flowDeviationPct", {
    name: "Flow deviation percent",
    type: "number",
    role: "value",
    unit: "%",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "watchdog.flowActual", {
    name: "Actual flow rate at the shared sensor (l/min)",
    type: "number",
    role: "value",
    unit: "l/min",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "watchdog.testNotify", {
    name: "Send test notification",
    type: "boolean",
    role: "button",
    read: true,
    write: true,
    def: false
  });
  await setObj(adapter, "waterConsumption.enabled", {
    name: "Water consumption tracking enabled",
    type: "boolean",
    role: "switch",
    read: true,
    write: false,
    def: false
  });
  await setObj(adapter, "waterConsumption.today", {
    name: "Water consumption today",
    type: "number",
    role: "value.fill",
    unit: "l",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "waterConsumption.week", {
    name: "Water consumption this week",
    type: "number",
    role: "value.fill",
    unit: "l",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "waterConsumption.month", {
    name: "Water consumption this month",
    type: "number",
    role: "value.fill",
    unit: "l",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "waterConsumption.total", {
    name: "Water consumption total",
    type: "number",
    role: "value.fill",
    unit: "l",
    read: true,
    write: false,
    def: 0
  });
  await setObj(adapter, "flowMonitor.enabled", {
    name: "Flow monitoring enabled",
    type: "boolean",
    role: "switch",
    read: true,
    write: false,
    def: false
  });
  await setObj(adapter, "flowMonitor.sensorId", {
    name: "Shared flow sensor state id (at the water source)",
    type: "string",
    role: "text",
    read: true,
    write: false,
    def: ""
  });
}
async function applyConfigToStates(adapter, config) {
  await adapter.setStateAsync("automation.active", { val: config.scheduler.autoMode, ack: true });
  await adapter.setStateAsync("automation.triggerMode", { val: config.scheduler.triggerMode, ack: true });
  await adapter.setStateAsync("automation.pauseOnRain", { val: config.scheduler.pauseOnRain, ack: true });
  await adapter.setStateAsync("automation.rainHysteresisMinutes", {
    val: config.scheduler.rainHysteresisMinutes,
    ack: true
  });
  await adapter.setStateAsync("automation.windPauseEnabled", { val: config.scheduler.windPauseEnabled, ack: true });
  await adapter.setStateAsync("automation.windSpeedStateId", { val: config.scheduler.windSpeedStateId, ack: true });
  await adapter.setStateAsync("automation.windSpeedLimit", { val: config.scheduler.windSpeedLimit, ack: true });
  await adapter.setStateAsync("automation.windGustStateId", { val: config.scheduler.windGustStateId, ack: true });
  await adapter.setStateAsync("automation.windGustLimit", { val: config.scheduler.windGustLimit, ack: true });
  await adapter.setStateAsync("automation.windHysteresisMinutes", {
    val: config.scheduler.windHysteresisMinutes,
    ack: true
  });
  await adapter.setStateAsync("automation.temperatureAdjustmentEnabled", {
    val: config.scheduler.temperatureAdjustmentEnabled,
    ack: true
  });
  await adapter.setStateAsync("automation.temperatureAdjustmentStateId", {
    val: config.scheduler.temperatureAdjustmentStateId,
    ack: true
  });
  await adapter.setStateAsync("automation.temperatureAdjustmentFactor", { val: 1, ack: true });
  await adapter.setStateAsync("automation.pumpCapacity", { val: config.scheduler.pumpCapacity, ack: true });
  await adapter.setStateAsync("automation.valvePause", { val: config.scheduler.valvePause, ack: true });
  await adapter.setStateAsync("automation.seasonEnabled", { val: config.scheduler.seasonEnabled, ack: true });
  await adapter.setStateAsync("automation.seasonStart", { val: config.scheduler.seasonStart, ack: true });
  await adapter.setStateAsync("automation.seasonEnd", { val: config.scheduler.seasonEnd, ack: true });
  await adapter.setStateAsync("automation.frostEnabled", { val: config.scheduler.frostEnabled, ack: true });
  await adapter.setStateAsync("automation.frostMinTemp", { val: config.scheduler.frostMinTemp, ack: true });
  await adapter.setStateAsync("sensors.rainId", { val: config.sensors.rainId, ack: true });
  await adapter.setStateAsync("sensors.soilMoistureId", { val: config.sensors.soilMoistureId, ack: true });
  await adapter.setStateAsync("sensors.temperatureId", { val: config.sensors.temperatureId, ack: true });
  await adapter.setStateAsync("weather.enabled", { val: config.weather.enabled, ack: true });
  await adapter.setStateAsync("legalRestriction.enabled", { val: config.legalRestriction.enabled, ack: true });
  await adapter.setStateAsync("legalRestriction.stationId", { val: config.legalRestriction.stationId, ack: true });
  await adapter.setStateAsync("legalRestriction.temperatureStateId", {
    val: config.legalRestriction.temperatureStateId,
    ack: true
  });
  await adapter.setStateAsync("legalRestriction.startDate", { val: config.legalRestriction.startDate, ack: true });
  await adapter.setStateAsync("legalRestriction.endDate", { val: config.legalRestriction.endDate, ack: true });
  await adapter.setStateAsync("legalRestriction.startTime", { val: config.legalRestriction.startTime, ack: true });
  await adapter.setStateAsync("legalRestriction.endTime", { val: config.legalRestriction.endTime, ack: true });
  await adapter.setStateAsync("legalRestriction.minTemperature", {
    val: config.legalRestriction.minTemperature,
    ack: true
  });
  await adapter.setStateAsync("waterConsumption.enabled", { val: config.waterConsumption.enabled, ack: true });
  await adapter.setStateAsync("flowMonitor.enabled", { val: config.flowMonitor.enabled, ack: true });
  await adapter.setStateAsync("flowMonitor.sensorId", { val: config.flowMonitor.sensorId, ack: true });
}
async function setObj(adapter, id, common) {
  await adapter.setObjectNotExistsAsync(id, {
    type: "state",
    common,
    native: {}
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyConfigToStates,
  createBaseStates
});
//# sourceMappingURL=states.js.map
