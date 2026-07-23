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
const DEFAULT_CONFIG = {
  expertMode: false,
  valves: [],
  plans: [{ name: "Alle", valveIndexes: [] }],
  scheduler: {
    autoMode: false,
    timerTimes: [],
    extensionFactor: 1,
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
  }
};
function normalizeConfig(config) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
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
  return {
    expertMode: (_m = config.expertMode) != null ? _m : DEFAULT_CONFIG.expertMode,
    valves: ((_n = config.valves) != null ? _n : []).map((valve) => {
      var _a2, _b2, _c2, _d2, _e2, _f2, _g2, _h2, _i2, _j2, _k2, _l2, _m2;
      return {
        name: (_a2 = valve.name) != null ? _a2 : "",
        type: (_b2 = valve.type) != null ? _b2 : "Generic",
        stateId: (_c2 = valve.stateId) != null ? _c2 : "",
        allOffId: valve.allOffId,
        runFor: (_d2 = valve.runFor) != null ? _d2 : 600,
        enabled: (_e2 = valve.enabled) != null ? _e2 : true,
        flowRateLpm: (_f2 = valve.flowRateLpm) != null ? _f2 : 0,
        duration: (_g2 = valve.duration) != null ? _g2 : 10,
        rainIndependent: (_h2 = valve.rainIndependent) != null ? _h2 : false,
        moistureThreshold: (_i2 = valve.moistureThreshold) != null ? _i2 : 0,
        manualDuration: (_k2 = (_j2 = valve.manualDuration) != null ? _j2 : valve.duration) != null ? _k2 : 10,
        flowSensorId: (_l2 = valve.flowSensorId) != null ? _l2 : "",
        days: (_m2 = valve.days) != null ? _m2 : []
      };
    }),
    plans: config.plans && config.plans.length > 0 ? config.plans.map((p) => {
      var _a2, _b2;
      return { name: (_a2 = p.name) != null ? _a2 : "", valveIndexes: (_b2 = p.valveIndexes) != null ? _b2 : [] };
    }) : DEFAULT_CONFIG.plans,
    scheduler: { ...DEFAULT_CONFIG.scheduler, ...config.scheduler },
    sensors: { ...DEFAULT_CONFIG.sensors, ...config.sensors },
    weather: { ...DEFAULT_CONFIG.weather, ...config.weather },
    legalRestriction,
    notifications: { ...DEFAULT_CONFIG.notifications, ...config.notifications },
    waterConsumption: { ...DEFAULT_CONFIG.waterConsumption, ...config.waterConsumption }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig
});
//# sourceMappingURL=config-defaults.js.map
