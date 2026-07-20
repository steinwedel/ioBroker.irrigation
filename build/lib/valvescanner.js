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
var valvescanner_exports = {};
__export(valvescanner_exports, {
  scanForValves: () => scanForValves
});
module.exports = __toCommonJS(valvescanner_exports);
function nameToString(name, fallback) {
  var _a;
  if (!name) {
    return fallback;
  }
  if (typeof name === "string") {
    return name;
  }
  return (_a = name.en) != null ? _a : fallback;
}
async function findAdapterInstances(adapter, adapterName) {
  const instanceObjects = await adapter.getForeignObjectsAsync(`system.adapter.${adapterName}.*`, "instance");
  return Object.keys(instanceObjects).filter((id) => /^system\.adapter\.[^.]+\.\d+$/.test(id)).map((id) => id.replace(/^system\.adapter\./, ""));
}
const FORBIDDEN_SCAN_ADAPTERS = ["admin", "irrigation", "alias"];
const SPECIALIZED_SCAN_ADAPTERS = ["smartgarden", "rainbird", "hm-rpc"];
async function scanForValves(adapter, type, instance, locationId, onProgress) {
  if (type === "All") {
    adapter.log.debug("Valve scan: type=All - running Gardena, Rainbird, Homematic and Generic scans");
    const steps = ["Gardena", "Rainbird", "Homematic", "Generic"];
    const valves = [];
    const errors = [];
    for (const step of steps) {
      onProgress == null ? void 0 : onProgress(`Scanning ${step}...`);
      const stepResult = await scanForValves(adapter, step, "", locationId);
      valves.push(...stepResult.valves);
      errors.push(...stepResult.errors);
    }
    return { valves, errors };
  }
  const namespace = instance.replace(/^system\.adapter\./, "");
  adapter.log.debug(
    `Valve scan: type=${type} instance="${instance}" namespace="${namespace}" locationId="${locationId != null ? locationId : ""}"`
  );
  const adapterName = namespace.split(".")[0];
  if (namespace && FORBIDDEN_SCAN_ADAPTERS.includes(adapterName)) {
    return { valves: [], errors: [`Scanning the "${adapterName}" instance is not allowed.`] };
  }
  if (type === "Generic" && namespace && SPECIALIZED_SCAN_ADAPTERS.includes(adapterName)) {
    return {
      valves: [],
      errors: [`The "${adapterName}" adapter has a dedicated scan type, use that instead of "Generic".`]
    };
  }
  switch (type) {
    case "Gardena":
      return scanGardena(adapter, namespace, locationId != null ? locationId : "");
    case "Homematic":
      return scanHomematic(adapter, namespace || void 0);
    case "Rainbird":
      return scanRainbird(adapter, namespace);
    case "Generic":
      return scanGeneric(adapter, namespace || void 0);
    default:
      return { valves: [], errors: [`Auto-discovery not supported for type "${String(type)}"`] };
  }
}
function extractGardenaName(val, fallback) {
  var _a;
  if (typeof val !== "string" || !val) {
    return fallback;
  }
  const trimmed = val.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (((_a = parsed == null ? void 0 : parsed.name) == null ? void 0 : _a.value) && typeof parsed.name.value === "string") {
      return parsed.name.value;
    }
  } catch {
  }
  return trimmed;
}
function isGardenaPlaceholderName(name) {
  return /^valve\s+\d+$/i.test(name.trim());
}
async function scanGardena(adapter, instance, locationId) {
  const errors = [];
  const valves = [];
  try {
    const instances = instance ? [instance] : await findAdapterInstances(adapter, "smartgarden");
    adapter.log.debug(
      `Gardena scan: scanning instance(s) ${instances.length ? instances.join(", ") : "(none found)"}`
    );
    for (const inst of instances) {
      const prefix = locationId ? `${inst}.${locationId}.` : `${inst}.`;
      const [durStates, stopStates] = await Promise.all([
        adapter.getForeignObjectsAsync(`${prefix}*.SERVICE_VALVE_*.duration_value`, "state"),
        adapter.getForeignObjectsAsync(`${prefix}*.SERVICE_VALVE_SET_*.stop_all_valves_i`, "state")
      ]);
      adapter.log.debug(
        `Gardena scan: instance="${inst}" durationStates=${Object.keys(durStates).length} stopStates=${Object.keys(stopStates).length}`
      );
      const stopLookup = new Set(Object.keys(stopStates));
      const durEntries = Object.entries(durStates);
      const nameStates = await Promise.all(
        durEntries.map(([id]) => {
          const nameStateId = `${id.slice(0, -".duration_value".length)}.name_value`;
          return adapter.getForeignStateAsync(nameStateId).catch(() => null);
        })
      );
      let skippedPlaceholders = 0;
      durEntries.forEach(([id], index) => {
        var _a;
        const basePath = id.slice(0, -".duration_value".length);
        const stopId = id.replace(
          /\.DEVICE_([^.]+)\.SERVICE_VALVE_\1-.+?\.duration_value$/,
          ".DEVICE_$1.SERVICE_VALVE_SET_$1.stop_all_valves_i"
        );
        const name = extractGardenaName((_a = nameStates[index]) == null ? void 0 : _a.val, basePath);
        if (isGardenaPlaceholderName(name)) {
          skippedPlaceholders++;
          return;
        }
        valves.push({
          name,
          type: "Gardena",
          stateId: id,
          allOffId: stopLookup.has(stopId) ? stopId : void 0,
          runFor: 600
        });
      });
      if (skippedPlaceholders > 0) {
        adapter.log.debug(
          `Gardena scan: instance="${inst}" skipped ${skippedPlaceholders} valve(s) with placeholder name (e.g. "Valve 1")`
        );
      }
    }
    adapter.log.debug(`Gardena scan: valves found=${valves.length} errors=${errors.length}`);
  } catch (error) {
    adapter.log.error(`Gardena scan failed: ${error.message}`);
    errors.push(`Gardena scan failed: ${error.message}`);
  }
  return { valves, errors };
}
const IRRIGATION_FUNCTION_NAMES = ["bew\xE4sserung", "irrigation"];
async function findIrrigationFunctionEnum(adapter) {
  var _a;
  const enums = await adapter.getForeignObjectsAsync("enum.functions.*", "enum");
  for (const enumObj of Object.values(enums)) {
    const name = (_a = enumObj == null ? void 0 : enumObj.common) == null ? void 0 : _a.name;
    const candidates = typeof name === "string" ? [name] : Object.values(name != null ? name : {});
    if (candidates.some(
      (candidate) => typeof candidate === "string" && IRRIGATION_FUNCTION_NAMES.includes(candidate.toLowerCase())
    )) {
      return enumObj;
    }
  }
  return null;
}
async function scanHomematic(adapter, instance) {
  var _a, _b;
  const errors = [];
  const valves = [];
  try {
    const functionEnum = await findIrrigationFunctionEnum(adapter);
    if (!functionEnum) {
      errors.push('No "Bew\xE4sserung"/"Irrigation" function enum found (enum.functions.*)');
      return { valves, errors };
    }
    const allMembers = (_b = (_a = functionEnum.common) == null ? void 0 : _a.members) != null ? _b : [];
    const members = instance ? allMembers.filter((memberId) => memberId.startsWith(`${instance}.`)) : allMembers;
    adapter.log.debug(
      `Homematic scan: function enum "${functionEnum._id}" has ${allMembers.length} member(s), ${members.length} match instance filter "${instance != null ? instance : "(none)"}"`
    );
    const stateIds = members.map((memberId) => `${memberId}.STATE`);
    const [stateObjects, memberObjects] = await Promise.all([
      Promise.all(stateIds.map((id) => adapter.getForeignObjectAsync(id).catch(() => null))),
      Promise.all(members.map((id) => adapter.getForeignObjectAsync(id).catch(() => null)))
    ]);
    members.forEach((memberId, index) => {
      var _a2, _b2;
      const stateObj = stateObjects[index];
      if (!stateObj || stateObj.type !== "state" || ((_a2 = stateObj.common) == null ? void 0 : _a2.role) !== "switch") {
        return;
      }
      const memberObj = memberObjects[index];
      valves.push({
        name: nameToString((_b2 = memberObj == null ? void 0 : memberObj.common) == null ? void 0 : _b2.name, memberId),
        type: "Homematic",
        stateId: memberId,
        runFor: 600
      });
    });
    adapter.log.debug(`Homematic scan: valves found=${valves.length} errors=${errors.length}`);
  } catch (error) {
    adapter.log.error(`Homematic scan failed: ${error.message}`);
    errors.push(`Homematic scan failed: ${error.message}`);
  }
  return { valves, errors };
}
async function scanRainbird(adapter, instance) {
  const errors = [];
  const valves = [];
  try {
    const instances = instance ? [instance] : await findAdapterInstances(adapter, "rainbird");
    for (const inst of instances) {
      const objects = await adapter.getForeignObjectsAsync(`${inst}.device.stations.*`, "state");
      const stopId = `${inst}.device.commands.stopIrrigation`;
      const stopExists = await adapter.getForeignObjectAsync(stopId).catch(() => null);
      const runZoneIds = Object.keys(objects).filter((id) => id.endsWith(".runZone"));
      for (const runZoneId of runZoneIds) {
        const basePath = runZoneId.slice(0, -".runZone".length);
        const stationMatch = /stations\.(\d+)/.exec(basePath);
        const stationNum = stationMatch ? stationMatch[1] : basePath;
        valves.push({
          name: `Station ${stationNum}`,
          type: "Rainbird",
          stateId: basePath,
          allOffId: stopExists ? stopId : void 0,
          runFor: 600
        });
      }
    }
  } catch (error) {
    errors.push(`Rainbird scan failed: ${error.message}`);
  }
  return { valves, errors };
}
function isSwitchState(obj) {
  var _a;
  return !!obj && obj.type === "state" && ((_a = obj.common) == null ? void 0 : _a.role) === "switch";
}
async function scanGeneric(adapter, instance) {
  var _a, _b;
  const errors = [];
  const valves = [];
  try {
    const functionEnum = await findIrrigationFunctionEnum(adapter);
    if (!functionEnum) {
      errors.push('No "Bew\xE4sserung"/"Irrigation" function enum found (enum.functions.*)');
      return { valves, errors };
    }
    const allMembers = (_b = (_a = functionEnum.common) == null ? void 0 : _a.members) != null ? _b : [];
    const members = allMembers.filter((memberId) => {
      const adapterName = memberId.replace(/^system\.adapter\./, "").split(".")[0];
      if (FORBIDDEN_SCAN_ADAPTERS.includes(adapterName) || SPECIALIZED_SCAN_ADAPTERS.includes(adapterName)) {
        return false;
      }
      return instance ? memberId.startsWith(`${instance}.`) : true;
    });
    adapter.log.debug(
      `Generic scan: function enum "${functionEnum._id}" has ${allMembers.length} member(s), ${members.length} after excluding specialized/forbidden adapters and applying instance filter "${instance != null ? instance : "(none)"}"`
    );
    const [memberObjects, memberStateObjects] = await Promise.all([
      Promise.all(members.map((id) => adapter.getForeignObjectAsync(id).catch(() => null))),
      Promise.all(members.map((id) => adapter.getForeignObjectAsync(`${id}.STATE`).catch(() => null)))
    ]);
    members.forEach((memberId, index) => {
      var _a2;
      const memberObj = memberObjects[index];
      let stateId;
      if (isSwitchState(memberObj)) {
        stateId = memberId;
      } else if (isSwitchState(memberStateObjects[index])) {
        stateId = `${memberId}.STATE`;
      } else {
        return;
      }
      valves.push({
        name: nameToString((_a2 = memberObj == null ? void 0 : memberObj.common) == null ? void 0 : _a2.name, memberId),
        type: "Generic",
        stateId,
        runFor: 600
      });
    });
    adapter.log.debug(`Generic scan: valves found=${valves.length} errors=${errors.length}`);
  } catch (error) {
    adapter.log.error(`Generic scan failed: ${error.message}`);
    errors.push(`Generic scan failed: ${error.message}`);
  }
  return { valves, errors };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  scanForValves
});
//# sourceMappingURL=valvescanner.js.map
