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
var hysteresis_exports = {};
__export(hysteresis_exports, {
  evaluateHysteresisPause: () => evaluateHysteresisPause,
  hysteresisMinutesToMs: () => hysteresisMinutesToMs
});
module.exports = __toCommonJS(hysteresis_exports);
function evaluateHysteresisPause(params) {
  const { overLimit, belowSinceMs, nowMs, hysteresisMs } = params;
  if (overLimit) {
    return { paused: true, belowSinceMs: null };
  }
  const effectiveBelowSinceMs = belowSinceMs != null ? belowSinceMs : nowMs;
  const elapsedMs = nowMs - effectiveBelowSinceMs;
  return { paused: elapsedMs < hysteresisMs, belowSinceMs: effectiveBelowSinceMs };
}
function hysteresisMinutesToMs(minutes) {
  return Math.max(0, Number.isFinite(minutes) ? minutes : 10) * 6e4;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  evaluateHysteresisPause,
  hysteresisMinutesToMs
});
//# sourceMappingURL=hysteresis.js.map
