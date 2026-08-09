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
var config_defaults_exports = {};
__export(config_defaults_exports, {
  DEFAULT_CONFIG: () => DEFAULT_CONFIG,
  normalizeConfig: () => normalizeConfig
});
module.exports = __toCommonJS(config_defaults_exports);
var import_duration = require("./duration");
const DEFAULT_CONFIG = {
  expertMode: false,
  valves: [],
  nextValveId: 0,
  plans: [{ name: "All", valveIndexes: [] }],
  scheduler: {
    autoMode: false,
    pauseOnRain: false,
    rainHysteresisMinutes: 10,
    windPauseEnabled: false,
    windSpeedStateId: "",
    windSpeedLimit: 0,
    windGustStateId: "",
    windGustLimit: 0,
    windHysteresisMinutes: 10,
    timerTimes: [],
    triggerMode: "timer",
    temperatureAdjustmentEnabled: false,
    temperatureAdjustmentStateId: "",
    pumpCapacity: 0,
    valvePause: 0,
    seasonEnabled: false,
    seasonStart: 4,
    seasonEnd: 10,
    frostEnabled: false,
    frostMinTemp: 2,
    icalAdapterInstance: "",
    icalTriggerState: "",
    icalTitlePrefix: "Bew\xE4sserung"
  },
  sensors: {
    rainId: "",
    soilMoistureId: "",
    temperatureId: ""
  },
  weather: {
    enabled: false,
    apiType: "openweathermap",
    apiKey: "",
    latitude: 0,
    longitude: 0,
    pollInterval: 30
  },
  legalRestriction: {
    enabled: false,
    stationId: "10400",
    temperatureStateId: "",
    startDate: "1.6",
    endDate: "30.9",
    startTime: "11:00",
    endTime: "17:00",
    minTemperature: 27,
    checkInterval: 10
  },
  notifications: {
    pushoverInstance: "",
    telegramInstance: ""
  },
  waterConsumption: {
    enabled: false
  },
  flowMonitor: {
    enabled: false,
    sensorId: ""
  }
};
function normalizeDays(days) {
  const values = Array.isArray(days) ? days : typeof days === "string" ? days.split(",") : [];
  return [
    ...new Set(values.map((value) => Number(value)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))
  ].sort((a, b) => a - b);
}
function normalizeConfig(config) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s;
  const legacyRestriction = config.legalRestriction;
  const legacyStartMonth = (_a = legacyRestriction == null ? void 0 : legacyRestriction.monthStart) != null ? _a : 6;
  const legacyEndMonth = (_b = legacyRestriction == null ? void 0 : legacyRestriction.monthEnd) != null ? _b : 9;
  const legalRestriction = {
    ...DEFAULT_CONFIG.legalRestriction,
    ...config.legalRestriction,
    startDate: (_d = (_c = config.legalRestriction) == null ? void 0 : _c.startDate) != null ? _d : `1.${legacyStartMonth}`,
    endDate: (_f = (_e = config.legalRestriction) == null ? void 0 : _e.endDate) != null ? _f : `${new Date(2e3, legacyEndMonth, 0).getDate()}.${legacyEndMonth}`,
    startTime: (_i = (_g = config.legalRestriction) == null ? void 0 : _g.startTime) != null ? _i : `${String((_h = legacyRestriction == null ? void 0 : legacyRestriction.hourStart) != null ? _h : 11).padStart(2, "0")}:00`,
    endTime: (_l = (_j = config.legalRestriction) == null ? void 0 : _j.endTime) != null ? _l : `${String((_k = legacyRestriction == null ? void 0 : legacyRestriction.hourEnd) != null ? _k : 17).padStart(2, "0")}:00`
  };
  const legacySoilMoistureId = ((_n = (_m = config.sensors) == null ? void 0 : _m.soilMoistureId) == null ? void 0 : _n.trim()) || void 0;
  const expertMode = (_o = config.expertMode) != null ? _o : DEFAULT_CONFIG.expertMode;
  return {
    expertMode,
    valves: (Array.isArray(config.valves) ? config.valves : []).map((valve, index) => {
      var _a2, _b2, _c2, _d2, _e2, _f2, _g2, _h2, _i2;
      const legacyRunFor = valve.runFor;
      const duration = typeof valve.duration === "number" ? Math.max(1, Math.round(valve.duration * 60)) : Math.max(1, (0, import_duration.parseDuration)((_a2 = valve.duration) != null ? _a2 : legacyRunFor !== void 0 ? legacyRunFor : "10"));
      return {
        // Falls back to the current array index only for pre-existing entries
        // that predate this field, so their real ioBroker object id (which is
        // derived from `id`, see formatValveNumber()) stays exactly what it
        // already was - see the IValveConfig.id doc comment.
        id: typeof valve.id === "number" ? valve.id : index,
        name: (_b2 = valve.name) != null ? _b2 : "",
        type: (_c2 = valve.type) != null ? _c2 : "Generic",
        stateId: (_d2 = valve.stateId) != null ? _d2 : "",
        allOffId: valve.allOffId,
        enabled: (_e2 = valve.enabled) != null ? _e2 : true,
        flowRateLpm: (_f2 = valve.flowRateLpm) != null ? _f2 : 0,
        duration,
        rainIndependent: (_g2 = valve.rainIndependent) != null ? _g2 : false,
        moistureThreshold: (_h2 = valve.moistureThreshold) != null ? _h2 : 0,
        soilMoistureId: ((_i2 = valve.soilMoistureId) == null ? void 0 : _i2.trim()) || legacySoilMoistureId,
        manualDuration: typeof valve.manualDuration === "number" ? Math.max(1, Math.round(valve.manualDuration * 60)) : valve.manualDuration === void 0 ? 600 : Math.max(1, (0, import_duration.parseDuration)(valve.manualDuration)),
        days: normalizeDays(valve.days)
      };
    }),
    nextValveId: (_p = config.nextValveId) != null ? _p : DEFAULT_CONFIG.nextValveId,
    plans: config.plans && config.plans.length > 0 ? config.plans.map((p) => {
      var _a2, _b2;
      return { name: (_a2 = p.name) != null ? _a2 : "", valveIndexes: (_b2 = p.valveIndexes) != null ? _b2 : [] };
    }) : DEFAULT_CONFIG.plans,
    // "Timer times" and the iCal trigger are mutually exclusive alternatives
    // (see ISchedulerConfig.triggerMode doc comment). Configs saved before this
    // field existed have no `triggerMode` at all; for those, infer "ical" if an
    // iCal trigger state was already configured (preserving their existing
    // behavior across the upgrade), otherwise default to "timer".
    //
    // The iCal trigger mode is an expert-only feature (the admin UI hides the
    // "Trigger mode" selector and every iCal-related field unless Expert mode
    // is on). If expert mode is off - whether it never was on, or the user
    // just turned it off after previously configuring iCal - force "timer" here
    // unconditionally, regardless of what is still saved in native config. This
    // keeps scheduling behavior consistent with what the admin UI actually shows
    // and lets the user toggle: without needing to remember to first switch the
    // (now hidden) trigger mode back manually.
    scheduler: {
      ...DEFAULT_CONFIG.scheduler,
      ...config.scheduler,
      triggerMode: !expertMode ? "timer" : (_s = (_q = config.scheduler) == null ? void 0 : _q.triggerMode) != null ? _s : ((_r = config.scheduler) == null ? void 0 : _r.icalTriggerState) ? "ical" : DEFAULT_CONFIG.scheduler.triggerMode
    },
    sensors: { ...DEFAULT_CONFIG.sensors, ...config.sensors },
    weather: { ...DEFAULT_CONFIG.weather, ...config.weather },
    legalRestriction,
    notifications: { ...DEFAULT_CONFIG.notifications, ...config.notifications },
    waterConsumption: { ...DEFAULT_CONFIG.waterConsumption, ...config.waterConsumption },
    flowMonitor: { ...DEFAULT_CONFIG.flowMonitor, ...config.flowMonitor }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig
});
//# sourceMappingURL=config-defaults.js.map
