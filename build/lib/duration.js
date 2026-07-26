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
var duration_exports = {};
__export(duration_exports, {
  formatDuration: () => formatDuration,
  parseDuration: () => parseDuration
});
module.exports = __toCommonJS(duration_exports);
function parseDuration(value, fallback = 600) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  const parts = value.trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return fallback;
  }
  const values = parts.map(Number);
  let seconds;
  if (values.length === 1) {
    seconds = values[0] * 60;
  } else if (values.length === 2) {
    seconds = values[0] * 60 + values[1];
  } else {
    seconds = values[0] * 3600 + values[1] * 60 + values[2];
  }
  return seconds > 0 ? seconds : 1;
}
function formatDuration(seconds) {
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remainingSeconds = value % 60;
  const formattedMinutes = String(minutes).padStart(2, "0");
  const formattedSeconds = String(remainingSeconds).padStart(2, "0");
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${formattedMinutes}:${formattedSeconds}` : `${formattedMinutes}:${formattedSeconds}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  formatDuration,
  parseDuration
});
//# sourceMappingURL=duration.js.map
