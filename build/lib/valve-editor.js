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
var valve_editor_exports = {};
__export(valve_editor_exports, {
  applyValveEditorFields: () => applyValveEditorFields,
  buildValveEditorOptions: () => buildValveEditorOptions,
  getValveEditorFields: () => getValveEditorFields
});
module.exports = __toCommonJS(valve_editor_exports);
var import_config_defaults = require("./config-defaults");
var import_duration = require("./duration");
var import_types = require("./types");
function normalizeEditorValves(rawValves) {
  if (!Array.isArray(rawValves)) {
    return void 0;
  }
  const editorValves = rawValves.map((rawValve) => {
    if (!rawValve || typeof rawValve !== "object") {
      return rawValve;
    }
    const valve = rawValve;
    return {
      ...valve,
      duration: typeof valve.duration === "number" ? (0, import_duration.formatDuration)(valve.duration) : valve.duration,
      manualDuration: typeof valve.manualDuration === "number" ? (0, import_duration.formatDuration)(valve.manualDuration) : valve.manualDuration
    };
  });
  return (0, import_config_defaults.normalizeConfig)({ valves: editorValves }).valves;
}
function readValveId(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : void 0;
}
function parseEditorDuration(value) {
  if (typeof value !== "string" || !/^(?:\d+|(?:\d+:)?[0-5]\d:[0-5]\d)$/.test(value.trim())) {
    return void 0;
  }
  return (0, import_duration.parseDuration)(value);
}
function parseEditorDays(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const text = value.trim();
  if (!text) {
    return [];
  }
  if (!/^[0-6](?:\s*,\s*[0-6])*$/.test(text)) {
    return void 0;
  }
  return [...new Set(text.split(",").map((day) => Number(day.trim())))].sort((a, b) => a - b);
}
function isValveType(value) {
  return value === "Gardena" || value === "Homematic" || value === "Rainbird" || value === "Hydrawise" || value === "Generic";
}
function readTrimmedString(value) {
  return typeof value === "string" ? value.trim() : void 0;
}
function buildValveEditorOptions(rawValves) {
  const valves = normalizeEditorValves(rawValves);
  if (!valves) {
    return [];
  }
  return valves.map((valve, index) => {
    var _a;
    const id = (_a = valve.id) != null ? _a : index;
    return {
      label: `[${(0, import_types.formatValveNumber)(id)}] ${valve.name || "unnamed"}`,
      value: id
    };
  });
}
function getValveEditorFields(rawValves, rawValveId) {
  var _a;
  const valves = normalizeEditorValves(rawValves);
  const valveId = readValveId(rawValveId);
  if (!valves || valveId === void 0) {
    return void 0;
  }
  const valve = valves.find((candidate, index) => {
    var _a2;
    return ((_a2 = candidate.id) != null ? _a2 : index) === valveId;
  });
  if (!valve) {
    return void 0;
  }
  return {
    _valveEditorName: valve.name,
    _valveEditorType: valve.type,
    _valveEditorStateId: valve.stateId,
    _valveEditorDuration: (0, import_duration.formatDuration)(valve.duration),
    _valveEditorEnabled: valve.enabled,
    _valveEditorFlowRateLpm: valve.flowRateLpm,
    _valveEditorRainIndependent: valve.rainIndependent,
    _valveEditorMoistureThreshold: valve.moistureThreshold,
    _valveEditorManualDuration: (0, import_duration.formatDuration)(valve.manualDuration),
    _valveEditorDays: [...valve.days].sort((a, b) => a - b).join(","),
    _valveEditorAllOffId: (_a = valve.allOffId) != null ? _a : ""
  };
}
function applyValveEditorFields(rawValves, rawValveId, rawFields) {
  const valves = normalizeEditorValves(rawValves);
  const valveId = readValveId(rawValveId);
  if (valveId === void 0) {
    return { error: "noValveSelected" };
  }
  if (!valves) {
    return { error: "valveNotFound" };
  }
  const valveIndex = valves.findIndex((valve, index) => {
    var _a;
    return ((_a = valve.id) != null ? _a : index) === valveId;
  });
  if (valveIndex < 0) {
    return { error: "valveNotFound" };
  }
  const fields = rawFields;
  const name = readTrimmedString(fields._valveEditorName);
  const type = fields._valveEditorType;
  const stateId = readTrimmedString(fields._valveEditorStateId);
  const allOffId = readTrimmedString(fields._valveEditorAllOffId);
  const duration = parseEditorDuration(fields._valveEditorDuration);
  const manualDuration = parseEditorDuration(fields._valveEditorManualDuration);
  const days = parseEditorDays(fields._valveEditorDays);
  const flowRateLpm = fields._valveEditorFlowRateLpm;
  const moistureThreshold = fields._valveEditorMoistureThreshold;
  if (duration === void 0 || manualDuration === void 0) {
    return { error: "invalidDuration" };
  }
  if (days === void 0) {
    return { error: "invalidDays" };
  }
  if (typeof flowRateLpm !== "number" || !Number.isFinite(flowRateLpm) || flowRateLpm < 0 || typeof moistureThreshold !== "number" || !Number.isFinite(moistureThreshold) || moistureThreshold < 0 || moistureThreshold > 100) {
    return { error: "invalidNumbers" };
  }
  if (name === void 0 || stateId === void 0 || allOffId === void 0 || !isValveType(type) || typeof fields._valveEditorEnabled !== "boolean" || typeof fields._valveEditorRainIndependent !== "boolean") {
    return { error: "valveNotFound" };
  }
  const updatedValve = {
    ...valves[valveIndex],
    name,
    type,
    stateId,
    allOffId: allOffId || void 0,
    duration,
    enabled: fields._valveEditorEnabled,
    flowRateLpm,
    rainIndependent: fields._valveEditorRainIndependent,
    moistureThreshold,
    manualDuration,
    days
  };
  return { valves: valves.map((valve, index) => index === valveIndex ? updatedValve : valve) };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyValveEditorFields,
  buildValveEditorOptions,
  getValveEditorFields
});
//# sourceMappingURL=valve-editor.js.map
