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
    monthStart: 6,
    monthEnd: 9,
    hourStart: 11,
    hourEnd: 17,
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
  var _a, _b;
  return {
    expertMode: (_a = config.expertMode) != null ? _a : DEFAULT_CONFIG.expertMode,
    valves: ((_b = config.valves) != null ? _b : []).map((valve) => {
      var _a2, _b2, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
      return {
        name: (_a2 = valve.name) != null ? _a2 : "",
        type: (_b2 = valve.type) != null ? _b2 : "Generic",
        stateId: (_c = valve.stateId) != null ? _c : "",
        allOffId: valve.allOffId,
        runFor: (_d = valve.runFor) != null ? _d : 600,
        enabled: (_e = valve.enabled) != null ? _e : true,
        flowRateLpm: (_f = valve.flowRateLpm) != null ? _f : 0,
        duration: (_g = valve.duration) != null ? _g : 10,
        rainIndependent: (_h = valve.rainIndependent) != null ? _h : false,
        moistureThreshold: (_i = valve.moistureThreshold) != null ? _i : 0,
        manualDuration: (_k = (_j = valve.manualDuration) != null ? _j : valve.duration) != null ? _k : 10,
        flowSensorId: (_l = valve.flowSensorId) != null ? _l : "",
        days: (_m = valve.days) != null ? _m : []
      };
    }),
    plans: config.plans && config.plans.length > 0 ? config.plans.map((p) => {
      var _a2, _b2;
      return { name: (_a2 = p.name) != null ? _a2 : "", valveIndexes: (_b2 = p.valveIndexes) != null ? _b2 : [] };
    }) : DEFAULT_CONFIG.plans,
    scheduler: { ...DEFAULT_CONFIG.scheduler, ...config.scheduler },
    sensors: { ...DEFAULT_CONFIG.sensors, ...config.sensors },
    weather: { ...DEFAULT_CONFIG.weather, ...config.weather },
    legalRestriction: { ...DEFAULT_CONFIG.legalRestriction, ...config.legalRestriction },
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
