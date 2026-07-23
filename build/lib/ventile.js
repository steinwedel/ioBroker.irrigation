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
var ventile_exports = {};
__export(ventile_exports, {
  ValveController: () => ValveController,
  rainbirdInstanceOf: () => rainbirdInstanceOf
});
module.exports = __toCommonJS(ventile_exports);
var import_types = require("./types");
var import_rate_limiter = require("./rate-limiter");
function parseGardenaLeftoverMinutes(val) {
  let minutes = 0;
  if (typeof val === "number" && Number.isFinite(val)) {
    minutes = val;
  } else if (typeof val === "string") {
    const parsed = parseInt(val, 10);
    minutes = Number.isFinite(parsed) ? parsed : 0;
  }
  return Math.max(0, minutes) * 60;
}
function gardenaValveBasePath(durationValueId) {
  return durationValueId.replace(/\.duration_value$/, "");
}
function hydrawiseZoneBasePath(runZoneId) {
  return runZoneId.replace(/\.runZone$/, "");
}
function rainbirdInstanceOf(stateId) {
  const match = /^(.+?)\.device\.stations\./.exec(stateId);
  return match == null ? void 0 : match[1];
}
class ValveController {
  adapter;
  index;
  config;
  rateLimiter;
  /**
   * Returns all valve controllers of the adapter (including this one), used
   * by stop() to check whether another Rainbird zone on the same
   * controller is still running before firing the shared `allOffId`
   * (`stopIrrigation`) command - which otherwise would stop every zone on
   * that Rainbird controller, not just this one. Provided as a getter
   * rather than a direct array reference since `main.ts` builds the full
   * `ValveController[]` list only after constructing each instance.
   */
  getAllValves;
  /**
   * 1s tick used to count down remainingTime for adapter-owned timer types
   * (Homematic/Generic). This is the single source of truth for the
   * auto-stop: when the countdown reaches 0 the tick itself calls stop().
   */
  tickTimer;
  running = false;
  startedAt = 0;
  durationSecs = 0;
  remainingSecs = 0;
  /**
   * Counts "state" echoes written by setRunningState() that this instance
   * is still expecting to see come back through onOwnStateChange(). Used
   * to tell apart our own echo from a genuine external command reliably.
   *
   * Comparing the incoming value against the current `running` flag alone
   * (the previous approach) is not reliable: `running` can already have
   * been flipped again by a newer start()/stop() call by the time an
   * older echo for a previous call is processed, which would make that
   * stale echo look like a fresh command and re-trigger start()/stop().
   * That, in turn, produces another echo, ad infinitum - a tight,
   * timer-less feedback loop that pins a CPU core and can flood a foreign
   * adapter (e.g. Gardena/smartgarden) with commands.
   *
   * Every setRunningState() call increments this counter right before
   * writing the echo; onOwnStateChange() decrements it and treats the
   * change as a no-op echo whenever the counter is greater than zero,
   * regardless of the echoed value - it does not matter which of
   * possibly several pending echoes this one is, only that it is *some*
   * echo we are still owed for.
   */
  pendingEchoCount = 0;
  /**
   * Serializes every call that can write the "state" echo and/or trigger
   * start()/stop() for this valve - both onOwnStateChange()'s start()/stop()
   * calls and onForeignStateChange()'s direct setRunningState() calls (e.g.
   * from Gardena's activity_value/duration_leftover_i feedback) are chained
   * onto this promise, so none of them can ever run concurrently for this
   * valve instance.
   *
   * This matters because pendingEchoCount only tracks *how many* "state"
   * echoes are outstanding, not which call produced which one. If two
   * calls that each write "state" (whether from an own command or from a
   * foreign status update) interleave their `await`-separated steps, the
   * credit count stays numerically correct, but the actual `running`
   * value on record can end up not corresponding to the echo that a
   * subsequent onOwnStateChange() call consumes - reopening exactly the
   * kind of feedback-loop window pendingEchoCount is meant to close, just
   * via a different pair of racing callers than the original bug.
   */
  commandChain = Promise.resolve();
  constructor(adapter, index, config, rateLimiter, getAllValves) {
    this.adapter = adapter;
    this.index = index;
    this.config = config;
    this.rateLimiter = rateLimiter;
    this.getAllValves = getAllValves != null ? getAllValves : (() => [this]);
  }
  get id() {
    return `valves.valve_${(0, import_types.formatValveNumber)(this.index)}`;
  }
  getConfig() {
    return this.config;
  }
  isRunning() {
    return this.running;
  }
  /**
   * Create/update the ioBroker objects for this valve and subscribe to the
   * relevant status states depending on the valve type.
   */
  async init() {
    var _a, _b;
    await this.adapter.setObjectNotExistsAsync(this.id, {
      type: "channel",
      common: { name: this.config.name },
      native: {}
    });
    await this.adapter.extendObjectAsync(this.id, { common: { name: this.config.name } });
    await this.ensureState("name", {
      name: "Valve name",
      type: "string",
      role: "text",
      read: true,
      write: true,
      def: this.config.name
    });
    await this.ensureState("type", {
      name: "Valve type",
      type: "string",
      role: "text",
      read: true,
      write: false,
      def: this.config.type
    });
    await this.ensureState("stateId", {
      name: "Underlying state id",
      type: "string",
      role: "text",
      read: true,
      write: false,
      def: this.config.stateId
    });
    await this.ensureState("state", {
      name: "Valve on/off",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
      def: false
    });
    await this.adapter.extendObjectAsync(`${this.id}.state`, { common: { write: true } });
    await this.adapter.delObjectAsync(`${this.id}.runFor`).catch(() => void 0);
    await this.ensureState("remainingTime", {
      name: "Remaining time (seconds)",
      type: "number",
      role: "value",
      unit: "s",
      read: true,
      write: false,
      def: 0
    });
    await this.adapter.extendObjectAsync(`${this.id}.remainingTime`, { common: { role: "value", unit: "s" } });
    await this.ensureState("timestampStart", {
      name: "Start timestamp (ms, epoch)",
      type: "number",
      role: "value",
      read: true,
      write: false,
      def: 0
    });
    await this.adapter.extendObjectAsync(`${this.id}.timestampStart`, { common: { role: "value" } });
    await this.ensureState("allOffId", {
      name: "All-off command state id",
      type: "string",
      role: "text",
      read: true,
      write: false,
      def: (_a = this.config.allOffId) != null ? _a : ""
    });
    await this.ensureState("online", {
      name: "Valve reachable",
      type: "boolean",
      role: "indicator.reachable",
      read: true,
      write: false,
      def: true
    });
    await this.ensureState("errorLast", {
      name: "Last error",
      type: "string",
      role: "text",
      read: true,
      write: false,
      def: ""
    });
    await this.ensureState("enabled", {
      name: "Valve enabled",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
      def: this.config.enabled
    });
    await this.ensureState("flowRateLpm", {
      name: "Flow rate (l/min)",
      type: "number",
      role: "value",
      unit: "l/min",
      read: true,
      write: false,
      def: this.config.flowRateLpm
    });
    await this.ensureState("duration", {
      name: "Scheduled duration (min)",
      type: "number",
      role: "level.timer",
      unit: "min",
      read: true,
      write: true,
      min: 1,
      def: this.config.duration
    });
    await this.ensureState("rainIndependent", {
      name: "Rain independent",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
      def: this.config.rainIndependent
    });
    await this.ensureState("moistureThreshold", {
      name: "Moisture threshold (%)",
      type: "number",
      role: "value",
      unit: "%",
      read: true,
      write: true,
      min: 0,
      max: 100,
      def: this.config.moistureThreshold
    });
    await this.ensureState("manualStart", {
      name: "Start manually",
      type: "boolean",
      role: "button",
      read: true,
      write: true,
      def: false
    });
    await this.ensureState("manualDuration", {
      name: "Manual run duration (min)",
      type: "number",
      role: "level.timer",
      unit: "min",
      read: true,
      write: true,
      min: 1,
      def: this.config.manualDuration
    });
    await this.ensureState("flowSensorId", {
      name: "Flow sensor state id",
      type: "string",
      role: "text",
      read: true,
      write: true,
      def: this.config.flowSensorId
    });
    await this.ensureState("days", {
      name: "Weekdays (JSON)",
      type: "string",
      role: "list",
      read: true,
      write: true,
      def: JSON.stringify(this.config.days)
    });
    await this.adapter.setStateAsync(`${this.id}.name`, { val: this.config.name, ack: true });
    await this.adapter.setStateAsync(`${this.id}.type`, { val: this.config.type, ack: true });
    await this.adapter.setStateAsync(`${this.id}.stateId`, { val: this.config.stateId, ack: true });
    await this.adapter.setStateAsync(`${this.id}.allOffId`, { val: (_b = this.config.allOffId) != null ? _b : "", ack: true });
    await this.adapter.setStateAsync(`${this.id}.enabled`, { val: this.config.enabled, ack: true });
    await this.adapter.setStateAsync(`${this.id}.flowRateLpm`, { val: this.config.flowRateLpm, ack: true });
    await this.adapter.setStateAsync(`${this.id}.duration`, { val: this.config.duration, ack: true });
    await this.adapter.setStateAsync(`${this.id}.rainIndependent`, { val: this.config.rainIndependent, ack: true });
    await this.adapter.setStateAsync(`${this.id}.moistureThreshold`, {
      val: this.config.moistureThreshold,
      ack: true
    });
    await this.adapter.setStateAsync(`${this.id}.manualDuration`, { val: this.config.manualDuration, ack: true });
    await this.adapter.setStateAsync(`${this.id}.flowSensorId`, { val: this.config.flowSensorId, ack: true });
    await this.adapter.setStateAsync(`${this.id}.days`, { val: JSON.stringify(this.config.days), ack: true });
    await this.subscribeStatus();
  }
  async ensureState(name, common) {
    await this.adapter.setObjectNotExistsAsync(`${this.id}.${name}`, {
      type: "state",
      common,
      native: {}
    });
  }
  async subscribeStatus() {
    try {
      switch (this.config.type) {
        case "Gardena": {
          const base = gardenaValveBasePath(this.config.stateId);
          await this.adapter.subscribeForeignStatesAsync(`${base}.activity_value`);
          await this.adapter.subscribeForeignStatesAsync(`${base}.duration_leftover_i`);
          break;
        }
        case "Homematic":
          await this.adapter.subscribeForeignStatesAsync(`${this.config.stateId}.STATE`);
          break;
        case "Rainbird":
          await this.adapter.subscribeForeignStatesAsync(`${this.config.stateId}.remaining`);
          break;
        case "Hydrawise":
          await this.adapter.subscribeForeignStatesAsync(
            `${hydrawiseZoneBasePath(this.config.stateId)}.time`
          );
          break;
        case "Generic":
          await this.adapter.subscribeForeignStatesAsync(this.config.stateId);
          break;
      }
    } catch (error) {
      this.adapter.log.warn(
        `Valve ${this.config.name}: failed to subscribe to status: ${error.message}`
      );
    }
  }
  /**
   * Handles a foreign state change for a subscribed status id. Returns true
   * if the change was consumed (belongs to this valve).
   *
   * @param id
   * @param state
   */
  async onForeignStateChange(id, state) {
    let matched = false;
    let action;
    switch (this.config.type) {
      case "Gardena": {
        const base = gardenaValveBasePath(this.config.stateId);
        if (id === `${base}.activity_value`) {
          matched = true;
          const activity = typeof (state == null ? void 0 : state.val) === "string" ? state.val : "CLOSED";
          const running = activity === "SCHEDULED_WATERING" || activity === "MANUAL_WATERING";
          action = async () => {
            await this.setRunningState(running, running ? void 0 : 0);
            if (running) {
              this.scheduleTick();
            } else {
              this.clearTickTimer();
            }
          };
        } else if (id === `${base}.duration_leftover_i`) {
          matched = true;
          const remainingSecs = parseGardenaLeftoverMinutes(state == null ? void 0 : state.val);
          action = () => this.setRunningState(remainingSecs > 0 || this.running, remainingSecs);
        }
        break;
      }
      case "Homematic":
        if (id === `${this.config.stateId}.STATE`) {
          matched = true;
          action = () => this.handleExternalOnOffDetected((state == null ? void 0 : state.val) === true);
        }
        break;
      case "Rainbird":
        if (id === `${this.config.stateId}.remaining`) {
          matched = true;
          const remaining = typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
          action = () => this.setRunningState(remaining > 0, remaining);
        }
        break;
      case "Hydrawise":
        if (id === `${hydrawiseZoneBasePath(this.config.stateId)}.time`) {
          matched = true;
          const remaining = typeof (state == null ? void 0 : state.val) === "number" ? state.val : 0;
          action = () => this.setRunningState(remaining > 0, remaining);
        }
        break;
      case "Generic":
        if (id === this.config.stateId) {
          matched = true;
          action = () => this.handleExternalOnOffDetected((state == null ? void 0 : state.val) === true);
        }
        break;
    }
    if (action) {
      this.commandChain = this.commandChain.then(action).catch((error) => {
        this.adapter.log.error(
          `Valve ${this.config.name}: unexpected error handling foreign state change: ${error.message}`
        );
      });
      await this.commandChain;
    }
    return matched;
  }
  /**
   * Called for Homematic/Generic valves when the hardware state was changed
   * externally (e.g. switched on directly on the Homematic actuator, not via
   * this adapter). These types have no device-internal timer/remaining-time
   * feedback, so if we detect an external "on" while we were not already
   * tracking a run, we must start our own countdown here too: default to
   * the configured duration, arm the adapter-owned auto-stop, and tick down
   * remainingTime, exactly like a start() triggered from within the adapter.
   *
   * @param hardwareOn
   */
  async handleExternalOnOffDetected(hardwareOn) {
    if (hardwareOn) {
      if (this.running) {
        await this.setRunningState(true, void 0);
        return;
      }
      this.clearTickTimer();
      const durationSecs = Math.round(this.config.duration * 60);
      this.durationSecs = durationSecs;
      this.remainingSecs = durationSecs;
      this.startedAt = Date.now();
      this.scheduleTick();
      await this.setRunningState(true, durationSecs);
      await this.adapter.setStateAsync(`${this.id}.timestampStart`, { val: this.startedAt, ack: true });
    } else {
      this.clearTickTimer();
      this.remainingSecs = 0;
      await this.setRunningState(false, 0);
    }
  }
  /**
   * Handles a command on one of this valve's own states, i.e. a manual
   * start/stop via the "state" mirror state, or an update of the duration
   * manual-start duration. Returns true if the change was consumed (belongs
   * to this valve).
   *
   * Normally only ack=false changes are commands (a user/script explicitly
   * requesting an action), while ack=true changes are just our own status
   * echo and must be ignored to avoid feedback loops. Own echoes are
   * recognized via `pendingEchoCount` (see field comment) rather than by
   * comparing the echoed value against `running`, since the latter is
   * subject to a race that can turn a stale echo into an apparent command
   * and cause a tight feedback loop. However, the admin "Objects" tab
   * edits a state's value directly and, depending on the admin version,
   * may submit that edit with ack=true instead of ack=false - from the
   * user's perspective this is still an explicit command ("turn this
   * valve on/off"). To support that, an ack=true change on "state" with no
   * pending echo is treated as a command if the value actually differs
   * from the currently tracked running state.
   *
   * @param id Adapter-relative id (namespace already stripped), e.g. "valves.valve_0.state"
   * @param state
   */
  async onOwnStateChange(id, state) {
    if (!state) {
      return false;
    }
    if (id === `${this.id}.state`) {
      const requestedOn = state.val === true;
      if (state.ack) {
        if (this.pendingEchoCount > 0) {
          this.pendingEchoCount--;
          return false;
        }
        if (requestedOn === this.running) {
          return false;
        }
      }
      this.commandChain = this.commandChain.then(() => requestedOn ? this.start() : this.stop()).catch((error) => {
        if (error instanceof import_rate_limiter.CancelledError) {
          return;
        }
        this.adapter.log.error(
          `Valve ${this.config.name}: unexpected error in command chain: ${error.message}`
        );
      });
      await this.commandChain;
      return true;
    }
    if (state.ack) {
      return false;
    }
    if (id === `${this.id}.duration`) {
      const duration = typeof state.val === "number" ? state.val : this.config.duration;
      this.config.duration = Math.max(1, duration);
      await this.adapter.setStateAsync(id, { val: this.config.duration, ack: true });
      return true;
    }
    return false;
  }
  async setRunningState(running, remainingSecs) {
    this.running = running;
    if (remainingSecs !== void 0) {
      this.remainingSecs = Math.max(0, remainingSecs);
    }
    this.pendingEchoCount++;
    await this.adapter.setStateAsync(`${this.id}.state`, { val: running, ack: true });
    if (remainingSecs !== void 0) {
      await this.adapter.setStateAsync(`${this.id}.remainingTime`, {
        val: Math.max(0, remainingSecs),
        ack: true
      });
    }
  }
  /**
   * Start this valve for the given duration in seconds. For device-internal
   * timer types (Gardena/Rainbird) the device handles the shutoff itself.
   * For Homematic/Generic the adapter must schedule the stop itself and
   * count down remainingTime every second.
   *
   * @param durationSecs Duration in seconds. Defaults to the configured duration when omitted.
   */
  async start(durationSecs) {
    var _a;
    if (!this.config.enabled) {
      return;
    }
    this.clearTickTimer();
    const effectiveDurationSecs = typeof durationSecs === "number" && durationSecs > 0 ? durationSecs : Math.round(this.config.duration * 60);
    this.durationSecs = effectiveDurationSecs;
    this.remainingSecs = effectiveDurationSecs;
    this.startedAt = Date.now();
    this.running = true;
    try {
      switch (this.config.type) {
        case "Gardena":
          await ((_a = this.rateLimiter) == null ? void 0 : _a.acquire(this.id));
          await this.adapter.setForeignStateAsync(this.config.stateId, String(effectiveDurationSecs));
          this.scheduleTick();
          break;
        case "Rainbird":
          await this.adapter.setForeignStateAsync(
            `${this.config.stateId}.runZone`,
            Math.ceil(effectiveDurationSecs / 60)
          );
          break;
        case "Hydrawise":
          await this.adapter.setForeignStateAsync(this.config.stateId, effectiveDurationSecs);
          break;
        case "Homematic":
          try {
            await this.adapter.setForeignStateAsync(
              `${this.config.stateId}.ON_TIME`,
              effectiveDurationSecs
            );
          } catch (error) {
            this.adapter.log.warn(
              `Valve ${this.config.name}: failed to set ON_TIME (continuing anyway): ${error.message}`
            );
          }
          await this.adapter.setForeignStateAsync(`${this.config.stateId}.STATE`, true);
          this.scheduleTick();
          break;
        case "Generic":
          await this.adapter.setForeignStateAsync(this.config.stateId, true);
          this.scheduleTick();
          break;
      }
      await this.setRunningState(true, effectiveDurationSecs);
      await this.adapter.setStateAsync(`${this.id}.timestampStart`, { val: this.startedAt, ack: true });
      await this.adapter.setStateAsync(`${this.id}.errorLast`, { val: "", ack: true });
    } catch (error) {
      if (error instanceof import_rate_limiter.CancelledError) {
        this.clearTickTimer();
        this.remainingSecs = 0;
        await this.setRunningState(false, 0);
        return;
      }
      this.clearTickTimer();
      this.remainingSecs = 0;
      const message = error.message;
      this.adapter.log.error(`Valve ${this.config.name}: failed to start: ${message}`);
      await this.setRunningState(false, 0);
      await this.adapter.setStateAsync(`${this.id}.errorLast`, { val: message, ack: true });
    }
  }
  /**
   * True if another *enabled, currently running* Rainbird valve on the
   * same Rainbird controller instance as this valve exists. Used by
   * stop() to decide whether firing the shared `allOffId`
   * ("stopIrrigation") command is safe - that command stops every zone on
   * the controller, so it must be suppressed while a sibling zone (e.g.
   * from a parallel pump-capacity batch, or a manual single-valve run
   * started while automation is running) still needs to keep watering.
   */
  otherSiblingRainbirdValveRunning() {
    const instance = rainbirdInstanceOf(this.config.stateId);
    if (!instance) {
      return false;
    }
    return this.getAllValves().some(
      (other) => other !== this && other.running && other.config.type === "Rainbird" && rainbirdInstanceOf(other.config.stateId) === instance
    );
  }
  /** Stop this valve immediately. */
  async stop() {
    var _a;
    if (!this.config.enabled) {
      return;
    }
    this.clearTickTimer();
    this.remainingSecs = 0;
    this.running = false;
    try {
      switch (this.config.type) {
        case "Gardena":
          await ((_a = this.rateLimiter) == null ? void 0 : _a.acquire(this.id));
          await this.adapter.setForeignStateAsync(this.config.stateId, "STOP_UNTIL_NEXT_TASK");
          break;
        case "Rainbird":
          if (this.config.allOffId && !this.otherSiblingRainbirdValveRunning()) {
            await this.adapter.setForeignStateAsync(this.config.allOffId, true);
          }
          break;
        case "Hydrawise":
          await this.adapter.setForeignStateAsync(
            `${hydrawiseZoneBasePath(this.config.stateId)}.stopZone`,
            true
          );
          break;
        case "Homematic":
          await this.adapter.setForeignStateAsync(`${this.config.stateId}.ON_TIME`, 0);
          await this.adapter.setForeignStateAsync(`${this.config.stateId}.STATE`, false);
          break;
        case "Generic":
          await this.adapter.setForeignStateAsync(this.config.stateId, false);
          break;
      }
      await this.setRunningState(false, 0);
    } catch (error) {
      if (error instanceof import_rate_limiter.CancelledError) {
        return;
      }
      const message = error.message;
      this.adapter.log.error(`Valve ${this.config.name}: failed to stop: ${message}`);
      await this.adapter.setStateAsync(`${this.id}.errorLast`, { val: message, ack: true });
    }
  }
  /**
   * Ticks remainingTime down every second for adapter-owned timer types
   * (Homematic/Generic) and for Gardena valves (whose
   * duration_leftover_i is only pushed by smartgarden every 60 s).
   *
   * For Homematic/Generic the tick is the single source of truth for the
   * auto-stop. For Gardena the tick stops counting at 0 without calling
   * stop() — the Gardena device closes the valve itself.
   */
  scheduleTick() {
    this.clearTickTimer();
    this.tickTimer = this.adapter.setInterval(() => {
      this.remainingSecs = Math.max(0, this.remainingSecs - 1);
      this.adapter.setStateAsync(`${this.id}.remainingTime`, { val: this.remainingSecs, ack: true }).catch(
        (error) => this.adapter.log.warn(
          `Valve ${this.config.name}: failed to update remainingTime: ${error.message}`
        )
      );
      if (this.remainingSecs <= 0) {
        this.clearTickTimer();
        if (this.config.type === "Gardena") {
          return;
        }
        this.commandChain = this.commandChain.then(() => this.stop()).catch((error) => {
          if (error instanceof import_rate_limiter.CancelledError) {
            return;
          }
          this.adapter.log.error(
            `Valve ${this.config.name}: auto-stop at remainingTime=0 failed: ${error.message}`
          );
        });
      }
    }, 1e3);
  }
  clearTickTimer() {
    if (this.tickTimer) {
      this.adapter.clearInterval(this.tickTimer);
      this.tickTimer = void 0;
    }
  }
  /** Remaining seconds, computed for adapter-owned timer types and Gardena. */
  getRemainingSecs() {
    if (this.config.type === "Homematic" || this.config.type === "Generic" || this.config.type === "Gardena") {
      return this.remainingSecs;
    }
    return 0;
  }
  /** Called on unload/onUnload to release adapter-owned timers. */
  destroy() {
    this.clearTickTimer();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ValveController,
  rainbirdInstanceOf
});
//# sourceMappingURL=ventile.js.map
