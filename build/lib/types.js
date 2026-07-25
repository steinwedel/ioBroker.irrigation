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
var types_exports = {};
__export(types_exports, {
  NONE_SENTINEL: () => NONE_SENTINEL,
  formatValveNumber: () => formatValveNumber,
  parsePlanValveTableRows: () => parsePlanValveTableRows,
  synchronizePlanWithValves: () => synchronizePlanWithValves
});
module.exports = __toCommonJS(types_exports);
function formatValveNumber(index) {
  return String(index).padStart(3, "0");
}
function parsePlanValveTableRows(rows, valveCount) {
  return rows.filter((row) => row == null ? void 0 : row.assigned).map((row) => {
    var _a;
    return Number.parseInt((_a = row.valveNumber) != null ? _a : "", 10);
  }).filter((index) => Number.isInteger(index) && index >= 0 && index < valveCount);
}
const NONE_SENTINEL = -1;
function synchronizePlanWithValves(plan, currentStateIds) {
  var _a, _b;
  const explicitlyEmpty = plan.valveIndexes.includes(NONE_SENTINEL);
  const legacySelectedStateIds = plan.valveIndexes.map((index) => currentStateIds[index]).filter((stateId) => Boolean(stateId));
  const selectedStateIds = [
    ...(_a = plan.valveStateIds) != null ? _a : plan.valveIndexes.length === 0 ? currentStateIds : legacySelectedStateIds
  ].filter((stateId) => currentStateIds.includes(stateId));
  const knownStateIds = (_b = plan.knownValveStateIds) != null ? _b : currentStateIds;
  if (!explicitlyEmpty) {
    for (const stateId of currentStateIds) {
      if (!knownStateIds.includes(stateId) && !selectedStateIds.includes(stateId)) {
        selectedStateIds.push(stateId);
      }
    }
  }
  const valveIndexes = selectedStateIds.map((stateId) => currentStateIds.indexOf(stateId));
  return {
    name: plan.name,
    valveIndexes: explicitlyEmpty ? [NONE_SENTINEL] : valveIndexes,
    valveStateIds: selectedStateIds,
    knownValveStateIds: currentStateIds
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  NONE_SENTINEL,
  formatValveNumber,
  parsePlanValveTableRows,
  synchronizePlanWithValves
});
//# sourceMappingURL=types.js.map
