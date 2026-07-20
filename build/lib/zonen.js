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
var zonen_exports = {};
__export(zonen_exports, {
  ZoneController: () => ZoneController
});
module.exports = __toCommonJS(zonen_exports);
class ZoneController {
  adapter;
  index;
  config;
  constructor(adapter, index, config) {
    this.adapter = adapter;
    this.index = index;
    this.config = config;
  }
  get id() {
    return `zones.zone_${this.index}`;
  }
  getConfig() {
    return this.config;
  }
  async init() {
    await this.adapter.setObjectNotExistsAsync(this.id, {
      type: "channel",
      common: { name: this.config.name },
      native: {}
    });
    await this.ensureState("name", "string", "text", true, this.config.name);
    await this.ensureState("valveId", "string", "text", true, String(this.config.valveIndex));
    await this.ensureState("duration", "number", "level.timer", true, this.config.duration, "min");
    await this.ensureState("enabled", "boolean", "switch", true, this.config.enabled);
    await this.ensureState("rainIndependent", "boolean", "switch", true, this.config.rainIndependent);
    await this.ensureState("moistureThreshold", "number", "value", true, this.config.moistureThreshold, "%");
    await this.ensureState("manualStart", "boolean", "button", true, false);
    await this.ensureState("manualDuration", "number", "level.timer", true, this.config.manualDuration, "min");
    await this.ensureState("flowSensorId", "string", "text", true, this.config.flowSensorId);
    await this.adapter.setObjectNotExistsAsync(`${this.id}.flowExpected`, {
      type: "state",
      common: {
        name: "Expected flow rate (calibrated)",
        type: "number",
        role: "value",
        unit: "l/min",
        read: true,
        write: true,
        def: 0
      },
      native: {}
    });
    await this.ensureState("flowActual", "number", "value", false, 0, "l/min");
    await this.ensureState("calibrateFlow", "boolean", "button", true, false);
    await this.ensureState("groups", "string", "json", true, JSON.stringify(this.config.groups));
    await this.ensureState("days", "string", "list", true, JSON.stringify(this.config.days));
    await this.ensureState("flowRate", "number", "value", true, this.config.flowRate, "l/min");
    await this.ensureState("waterCurrent", "number", "value.fill", false, 0, "l");
    await this.ensureState("waterTotal", "number", "value.fill", false, 0, "l");
  }
  async ensureState(name, type, role, write, def, unit) {
    await this.adapter.setObjectNotExistsAsync(`${this.id}.${name}`, {
      type: "state",
      common: {
        name,
        type,
        role,
        unit,
        read: true,
        write,
        def
      },
      native: {}
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ZoneController
});
//# sourceMappingURL=zonen.js.map
