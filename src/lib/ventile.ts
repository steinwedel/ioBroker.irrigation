import type { IValveConfig } from './types';
import { formatValveNumber } from './types';
import type { RateLimiter } from './rate-limiter';
import { CancelledError } from './rate-limiter';
import { formatDuration } from './duration';

/**
 * Parses the Gardena "duration_leftover_i" state value into remaining
 * seconds. The smartgarden adapter reports this internal countdown
 * datapoint as whole *minutes* (string-typed, e.g. "5", "0", "null"),
 * not seconds.
 *
 * @param val
 */
function parseGardenaLeftoverMinutes(val: ioBroker.StateValue | undefined): number {
    let minutes = 0;
    if (typeof val === 'number' && Number.isFinite(val)) {
        minutes = val;
    } else if (typeof val === 'string') {
        const parsed = parseInt(val, 10);
        minutes = Number.isFinite(parsed) ? parsed : 0;
    }
    return Math.max(0, minutes) * 60;
}

/**
 * Derives the Gardena SERVICE_VALVE base path from the "duration_value"
 * state id stored as stateId, e.g.
 * "...SERVICE_VALVE_xxx.duration_value" -> "...SERVICE_VALVE_xxx".
 *
 * @param durationValueId
 */
function gardenaValveBasePath(durationValueId: string): string {
    return durationValueId.replace(/\.duration_value$/, '');
}

function hydrawiseZoneBasePath(runZoneId: string): string {
    return runZoneId.replace(/\.runZone$/, '');
}

/**
 * Derives the Rainbird adapter instance namespace (e.g. "rainbird.0") from a
 * valve's `stateId`, which is the per-station base path written by
 * scanRainbird(), e.g. "rainbird.0.device.stations.1" -> "rainbird.0".
 * Returns undefined if the id does not look like a Rainbird station path,
 * so callers can safely skip the same-controller check rather than
 * mismatching unrelated instances against each other.
 *
 * Exported for buildBatches() in automation.ts, which uses this to keep
 * zones of the same Rainbird controller out of the same parallel batch (a
 * Rainbird controller can only physically open one station at a time, and
 * stop() commands the whole controller via `allOffId`/"stopIrrigation"
 * rather than a single zone - see the comment on otherSiblingRainbirdValveRunning()).
 *
 * @param stateId
 */
export function rainbirdInstanceOf(stateId: string): string | undefined {
    const match = /^(.+?)\.device\.stations\./.exec(stateId);
    return match?.[1];
}

/**
 * Controls a single valve, abstracting away the differences between
 * Gardena, Homematic, Rainbird and Generic systems.
 *
 * See plan section "Ventil-Ansteuerung (System-spezifisch)" for the
 * start/stop/timer matrix this implementation follows.
 */
export class ValveController {
    private readonly adapter: ioBroker.Adapter;
    private readonly index: number;
    private config: IValveConfig;
    private readonly rateLimiter: RateLimiter | undefined;
    /**
     * Returns all valve controllers of the adapter (including this one), used
     * by stop() to check whether another Rainbird zone on the same
     * controller is still running before firing the shared `allOffId`
     * (`stopIrrigation`) command - which otherwise would stop every zone on
     * that Rainbird controller, not just this one. Provided as a getter
     * rather than a direct array reference since `main.ts` builds the full
     * `ValveController[]` list only after constructing each instance.
     */
    private readonly getAllValves: () => ValveController[];
    private readonly onManualStateCommand: ((requestedOn: boolean) => Promise<void>) | undefined;
    /**
     * 1s tick used to count down remainingDuration for adapter-owned timer types
     * (Homematic/Generic). This is the single source of truth for the
     * auto-stop: when the countdown reaches 0 the tick itself calls stop().
     */
    private tickTimer: ReturnType<ioBroker.Adapter['setInterval']> | undefined;
    private running = false;
    private startedAt = 0;
    private durationSecs = 0;
    private remainingSecs = 0;
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
    private pendingEchoCount = 0;
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
    private commandChain: Promise<void> = Promise.resolve();

    public constructor(
        adapter: ioBroker.Adapter,
        index: number,
        config: IValveConfig,
        rateLimiter?: RateLimiter,
        getAllValves?: () => ValveController[],
        onManualStateCommand?: (requestedOn: boolean) => Promise<void>,
    ) {
        this.adapter = adapter;
        this.index = index;
        this.config = config;
        this.rateLimiter = rateLimiter;
        this.getAllValves = getAllValves ?? (() => [this]);
        this.onManualStateCommand = onManualStateCommand;
    }

    public get id(): string {
        // Prefer the valve's stable, never-reused config id (see IValveConfig.id)
        // over the constructor's `index` param, so this object id (and thus all
        // state history under it) stays constant even if the valve's row is
        // later reordered in the admin Valves table. `index` remains as a
        // fallback for configs/tests predating this field.
        return `valves.valve_${formatValveNumber(this.config.id ?? this.index)}`;
    }

    public getConfig(): IValveConfig {
        return this.config;
    }

    public isRunning(): boolean {
        return this.running;
    }

    /**
     * Create/update the ioBroker objects for this valve and subscribe to the
     * relevant status states depending on the valve type.
     */
    public async init(): Promise<void> {
        await this.adapter.setObjectNotExistsAsync(this.id, {
            type: 'channel',
            common: { name: this.config.name },
            native: {},
        });
        // Resync the channel display name too (see comment near the state resync below).
        await this.adapter.extendObjectAsync(this.id, { common: { name: this.config.name } });

        await this.ensureState('name', {
            name: 'Valve name',
            type: 'string',
            role: 'text',
            read: true,
            write: true,
            def: this.config.name,
        });
        await this.ensureState('type', {
            name: 'Valve type',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: this.config.type,
        });
        await this.ensureState('stateId', {
            name: 'Underlying state id',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: this.config.stateId,
        });
        await this.ensureState('state', {
            name: 'Valve on/off',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
            def: false,
        });
        // Migration: "state" used to be read-only (write: false). setObjectNotExistsAsync
        // above does not update existing objects, so force the permission change here.
        await this.adapter.extendObjectAsync(`${this.id}.state`, { common: { write: true } });
        await this.adapter.delObjectAsync(`${this.id}.runFor`).catch(() => undefined);
        // Migration: "remainingTime" was renamed to "remainingDuration". Remove the
        // stale object so it does not linger in the Objects view.
        await this.adapter.delObjectAsync(`${this.id}.remainingTime`).catch(() => undefined);
        await this.ensureState('remainingDuration', {
            name: 'Remaining duration (seconds)',
            type: 'number',
            role: 'value',
            unit: 's',
            read: true,
            write: false,
            def: 0,
        });
        // Migration: "remainingDuration" (formerly "remainingTime") used to have role
        // "value.timer". In this admin version that role causes the Objects view to
        // render the value as a formatted date/time string instead of a plain number,
        // so use the generic "value" role instead. setObjectNotExistsAsync above does
        // not update existing objects, so force the role change here.
        await this.adapter.extendObjectAsync(`${this.id}.remainingDuration`, { common: { role: 'value', unit: 's' } });
        await this.ensureState('remainingDurationMin', {
            name: 'Remaining time (mm:ss)',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: '00:00',
        });
        await this.ensureState('timestampStart', {
            name: 'Start timestamp (ms, epoch)',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            def: 0,
        });
        // Migration: "timestampStart" used to have role "value.time", which makes the
        // admin Objects view render it as a formatted date/time string instead of the
        // plain epoch-ms number. setObjectNotExistsAsync above does not update existing
        // objects, so force the role change here.
        await this.adapter.extendObjectAsync(`${this.id}.timestampStart`, { common: { role: 'value' } });
        await this.ensureState('allOffId', {
            name: 'All-off command state id',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: this.config.allOffId ?? '',
        });
        await this.ensureState('online', {
            name: 'Valve reachable',
            type: 'boolean',
            role: 'indicator.reachable',
            read: true,
            write: false,
            def: true,
        });
        await this.ensureState('errorLast', {
            name: 'Last error',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: '',
        });
        await this.ensureState('enabled', {
            name: 'Valve enabled',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
            def: this.config.enabled,
        });
        await this.ensureState('flowRateLpm', {
            name: 'Flow rate (l/min)',
            type: 'number',
            role: 'value',
            unit: 'l/min',
            read: true,
            write: false,
            def: this.config.flowRateLpm,
        });
        await this.ensureState('duration', {
            name: 'Scheduled duration',
            type: 'number',
            role: 'level.timer',
            unit: 's',
            read: true,
            write: true,
            min: 1,
            def: this.config.duration,
        });
        await this.ensureState('rainIndependent', {
            name: 'Rain independent',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
            def: this.config.rainIndependent,
        });
        await this.ensureState('moistureThreshold', {
            name: 'Moisture threshold (%)',
            type: 'number',
            role: 'value',
            unit: '%',
            read: true,
            write: true,
            min: 0,
            max: 100,
            def: this.config.moistureThreshold,
        });
        await this.ensureState('manualStart', {
            name: 'Start manually',
            type: 'boolean',
            role: 'button',
            read: true,
            write: true,
            def: false,
        });
        await this.ensureState('manualDuration', {
            name: 'Manual run duration',
            type: 'number',
            role: 'level.timer',
            unit: 's',
            read: true,
            write: true,
            min: 1,
            def: this.config.manualDuration,
        });
        // Migration: per-valve flow sensors never existed in the supported hardware
        // (there is only one shared flow sensor at the water source, see
        // IFlowMonitorConfig) - remove the stale per-valve object.
        await this.adapter.delObjectAsync(`${this.id}.flowSensorId`).catch(() => undefined);
        await this.ensureState('flowExpected', {
            name: 'Calibrated expected flow rate (l/min)',
            type: 'number',
            role: 'value',
            unit: 'l/min',
            read: true,
            write: false,
            def: 0,
        });
        await this.ensureState('calibrateFlow', {
            name: 'Calibrate expected flow rate',
            type: 'boolean',
            role: 'button',
            read: true,
            write: true,
            def: false,
        });
        await this.ensureState('days', {
            name: 'Weekdays (JSON)',
            type: 'string',
            role: 'list',
            read: true,
            write: true,
            def: JSON.stringify(this.config.days),
        });

        // Config-derived info states must always reflect the current config, even if
        // this valve slot (index) previously held a different valve (e.g. after
        // clearing/re-scanning). setObjectNotExistsAsync above never updates existing
        // objects/values, so force a resync here.
        await this.adapter.setStateAsync(`${this.id}.name`, { val: this.config.name, ack: true });
        await this.adapter.setStateAsync(`${this.id}.type`, { val: this.config.type, ack: true });
        await this.adapter.setStateAsync(`${this.id}.stateId`, { val: this.config.stateId, ack: true });
        await this.adapter.setStateAsync(`${this.id}.allOffId`, { val: this.config.allOffId ?? '', ack: true });
        await this.adapter.setStateAsync(`${this.id}.enabled`, { val: this.config.enabled, ack: true });
        await this.adapter.setStateAsync(`${this.id}.flowRateLpm`, { val: this.config.flowRateLpm, ack: true });
        await this.adapter.setStateAsync(`${this.id}.duration`, { val: this.config.duration, ack: true });
        await this.adapter.setStateAsync(`${this.id}.rainIndependent`, { val: this.config.rainIndependent, ack: true });
        await this.adapter.setStateAsync(`${this.id}.moistureThreshold`, {
            val: this.config.moistureThreshold,
            ack: true,
        });
        await this.adapter.setStateAsync(`${this.id}.manualDuration`, { val: this.config.manualDuration, ack: true });
        await this.adapter.setStateAsync(`${this.id}.days`, { val: JSON.stringify(this.config.days), ack: true });

        await this.subscribeStatus();
    }

    private async ensureState(name: string, common: ioBroker.StateCommon): Promise<void> {
        await this.adapter.setObjectNotExistsAsync(`${this.id}.${name}`, {
            type: 'state',
            common,
            native: {},
        });
    }

    private async subscribeStatus(): Promise<void> {
        try {
            switch (this.config.type) {
                case 'Gardena': {
                    // duration_value is write-only (the start/duration command); the actual
                    // running status is activity_value, and the live countdown (in minutes)
                    // is the internal duration_leftover_i datapoint.
                    const base = gardenaValveBasePath(this.config.stateId);
                    await this.adapter.subscribeForeignStatesAsync(`${base}.activity_value`);
                    await this.adapter.subscribeForeignStatesAsync(`${base}.duration_leftover_i`);
                    break;
                }
                case 'Homematic':
                    await this.adapter.subscribeForeignStatesAsync(`${this.config.stateId}.STATE`);
                    break;
                case 'Rainbird':
                    await this.adapter.subscribeForeignStatesAsync(`${this.config.stateId}.remaining`);
                    break;
                case 'Hydrawise':
                    await this.adapter.subscribeForeignStatesAsync(
                        `${hydrawiseZoneBasePath(this.config.stateId)}.time`,
                    );
                    break;
                case 'Generic':
                    await this.adapter.subscribeForeignStatesAsync(this.config.stateId);
                    break;
            }
        } catch (error) {
            this.adapter.log.warn(
                `Valve ${this.config.name}: failed to subscribe to status: ${(error as Error).message}`,
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
    public async onForeignStateChange(id: string, state: ioBroker.State | null | undefined): Promise<boolean> {
        let matched = false;
        let action: (() => Promise<void>) | undefined;
        switch (this.config.type) {
            case 'Gardena': {
                const base = gardenaValveBasePath(this.config.stateId);
                if (id === `${base}.activity_value`) {
                    matched = true;
                    const activity = typeof state?.val === 'string' ? state.val : 'CLOSED';
                    const running = activity === 'SCHEDULED_WATERING' || activity === 'MANUAL_WATERING';
                    action = async () => {
                        await this.setRunningState(running, running ? undefined : 0);
                        if (running && this.remainingSecs > 0) {
                            this.scheduleTick();
                        } else {
                            this.clearTickTimer();
                        }
                    };
                } else if (id === `${base}.duration_leftover_i`) {
                    matched = true;
                    const remainingSecs = parseGardenaLeftoverMinutes(state?.val);
                    // Only (re-)infer the running state from the countdown itself if we
                    // have not already got a definitive answer from activity_value.
                    action = async () => {
                        await this.setRunningState(remainingSecs > 0 || this.running, remainingSecs);
                        if (remainingSecs > 0) {
                            this.scheduleTick();
                        }
                    };
                }
                break;
            }
            case 'Homematic':
                if (id === `${this.config.stateId}.STATE`) {
                    matched = true;
                    action = () => this.handleExternalOnOffDetected(state?.val === true);
                }
                break;
            case 'Rainbird':
                if (id === `${this.config.stateId}.remaining`) {
                    matched = true;
                    const remaining = typeof state?.val === 'number' ? state.val : 0;
                    action = () => this.setRunningState(remaining > 0, remaining);
                }
                break;
            case 'Hydrawise':
                if (id === `${hydrawiseZoneBasePath(this.config.stateId)}.time`) {
                    matched = true;
                    const remaining = typeof state?.val === 'number' ? state.val : 0;
                    action = () => this.setRunningState(remaining > 0, remaining);
                }
                break;
            case 'Generic':
                if (id === this.config.stateId) {
                    matched = true;
                    action = () => this.handleExternalOnOffDetected(state?.val === true);
                }
                break;
        }
        if (action) {
            // Chained onto the same commandChain as onOwnStateChange()'s start()/stop()
            // calls: both paths write the "state" echo via setRunningState(), so they
            // must never run concurrently for this valve - see the commandChain field
            // comment for why interleaving them can desynchronize which echo belongs
            // to which call and reopen the feedback-loop window.
            this.commandChain = this.commandChain.then(action).catch(error => {
                this.adapter.log.error(
                    `Valve ${this.config.name}: unexpected error handling foreign state change: ${(error as Error).message}`,
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
     * remainingDuration, exactly like a start() triggered from within the adapter.
     *
     * @param hardwareOn
     */
    private async handleExternalOnOffDetected(hardwareOn: boolean): Promise<void> {
        if (hardwareOn) {
            if (this.running) {
                // Already tracking a run (started by us or a previous external
                // detection) - nothing to (re-)infer, just confirm the state.
                await this.setRunningState(true, undefined);
                return;
            }
            this.clearTickTimer();
            const durationSecs = this.config.duration;
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
     * start/stop via the "state" mirror state or an update of the scheduled
     * duration. State commands are delegated to the automation engine when a
     * manual-state handler was supplied. Returns true if the change belongs to
     * this valve.
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
    public async onOwnStateChange(id: string, state: ioBroker.State | null | undefined): Promise<boolean> {
        if (!state) {
            return false;
        }
        if (id === `${this.id}.state`) {
            const requestedOn = state.val === true;
            if (state.ack) {
                if (this.pendingEchoCount > 0) {
                    // Our own echo from setRunningState() (or one of several still in
                    // flight) - consume one credit and treat it as a no-op, regardless
                    // of the echoed value. See the pendingEchoCount field comment for
                    // why comparing against `running` here is not reliable.
                    this.pendingEchoCount--;
                    return false;
                }
                if (requestedOn === this.running) {
                    // No echo was pending, but the value already matches reality (e.g.
                    // a duplicate/retained event) - still a no-op, nothing to do.
                    return false;
                }
                // ack=true but genuinely differs from what we are tracking and no echo
                // was pending: this is the admin "Objects" tab edit case described
                // above - treat it as an explicit command.
            }
            // Chain onto commandChain (rather than awaiting start()/stop() directly)
            // so that a burst of rapid toggles is executed strictly one at a time -
            // see the commandChain field comment for why concurrent execution can
            // desynchronize pendingEchoCount and reopen the feedback-loop window.
            // start()/stop() already catch their own errors internally, but the
            // extra .catch() here is a deliberate safety net: without it, any
            // exception that ever escaped start()/stop() (now or after a future
            // change) would permanently reject commandChain, and every later
            // .then() chained onto a rejected promise silently skips its callback
            // - i.e. all subsequent valve commands would stop having any effect
            // at all, with no error surfaced anywhere.
            this.commandChain = this.commandChain
                .then(() =>
                    this.onManualStateCommand
                        ? this.onManualStateCommand(requestedOn)
                        : requestedOn
                          ? this.start()
                          : this.stop(),
                )
                .catch(error => {
                    if (error instanceof CancelledError) {
                        return;
                    }
                    this.adapter.log.error(
                        `Valve ${this.config.name}: unexpected error in command chain: ${(error as Error).message}`,
                    );
                });
            await this.commandChain;
            return true;
        }
        if (state.ack) {
            return false;
        }
        if (id === `${this.id}.duration`) {
            const duration = typeof state.val === 'number' ? state.val : this.config.duration;
            this.config.duration = Math.max(1, duration);
            await this.adapter.setStateAsync(id, { val: this.config.duration, ack: true });
            return true;
        }
        return false;
    }

    private async setRunningState(running: boolean, remainingSecs: number | undefined): Promise<void> {
        this.running = running;
        if (remainingSecs !== undefined) {
            this.remainingSecs = Math.max(0, remainingSecs);
        }
        this.pendingEchoCount++;
        await this.adapter.setStateAsync(`${this.id}.state`, { val: running, ack: true });
        if (remainingSecs !== undefined) {
            await this.adapter.setStateAsync(`${this.id}.remainingDuration`, {
                val: Math.max(0, remainingSecs),
                ack: true,
            });
            await this.adapter.setStateAsync(`${this.id}.remainingDurationMin`, {
                val: formatDuration(remainingSecs),
                ack: true,
            });
        }
    }

    /**
     * Best-effort write of the Homematic `ON_TIME` datapoint, shared by
     * start() (arms the auto-shutoff) and stop() (resets it so the actuator
     * does not re-arm itself from a stale value). Some Homematic actuators
     * expose ON_TIME under a different name or not at all, so a failure here
     * must never prevent the critical STATE=true/false command that follows
     * - it is only logged.
     *
     * @param value Duration in seconds to arm (start), or 0 to reset (stop).
     */
    private async setHomematicOnTime(value: number): Promise<void> {
        try {
            await this.adapter.setForeignStateAsync(`${this.config.stateId}.ON_TIME`, value);
        } catch (error) {
            this.adapter.log.warn(
                `Valve ${this.config.name}: failed to set ON_TIME (continuing anyway): ${(error as Error).message}`,
            );
        }
    }

    /**
     * Start this valve for the given duration in seconds. For device-internal
     * timer types (Gardena/Rainbird) the device handles the shutoff itself.
     * For Homematic/Generic the adapter must schedule the stop itself and
     * count down remainingDuration every second.
     *
     * @param durationSecs Duration in seconds. Defaults to the configured duration when omitted.
     */
    public async start(durationSecs?: number): Promise<void> {
        if (!this.config.enabled) {
            return;
        }
        this.clearTickTimer();
        const effectiveDurationSecs =
            typeof durationSecs === 'number' && durationSecs > 0 ? durationSecs : this.config.duration;
        this.durationSecs = effectiveDurationSecs;
        this.remainingSecs = effectiveDurationSecs;
        this.startedAt = Date.now();
        // Set this synchronously before sending any hardware command below, so that
        // an echoed foreign-state-change event (e.g. Homematic STATE=true) arriving
        // while we are still awaiting cannot be mistaken for an externally triggered
        // start and reset/duplicate the countdown we are setting up here.
        this.running = true;

        try {
            switch (this.config.type) {
                case 'Gardena':
                    await this.rateLimiter?.acquire(this.id);
                    await this.adapter.setForeignStateAsync(this.config.stateId, String(effectiveDurationSecs));
                    this.scheduleTick();
                    break;
                case 'Rainbird':
                    await this.adapter.setForeignStateAsync(
                        `${this.config.stateId}.runZone`,
                        Math.ceil(effectiveDurationSecs / 60),
                    );
                    break;
                case 'Hydrawise':
                    await this.adapter.setForeignStateAsync(this.config.stateId, effectiveDurationSecs);
                    break;
                case 'Homematic':
                    // ON_TIME is best-effort (some Homematic actuators expose it under a
                    // different name or not at all): a failure here must not prevent the
                    // actual STATE=true switch command, and - crucially - must not skip
                    // arming the adapter-owned countdown timer below. Without the timer,
                    // remainingDuration would never count down and the valve would never be
                    // auto-stopped by the adapter.
                    await this.setHomematicOnTime(effectiveDurationSecs);
                    await this.adapter.setForeignStateAsync(`${this.config.stateId}.STATE`, true);
                    this.scheduleTick();
                    break;
                case 'Generic':
                    await this.adapter.setForeignStateAsync(this.config.stateId, true);
                    this.scheduleTick();
                    break;
            }

            await this.setRunningState(true, effectiveDurationSecs);
            await this.adapter.setStateAsync(`${this.id}.timestampStart`, { val: this.startedAt, ack: true });
            await this.adapter.setStateAsync(`${this.id}.errorLast`, { val: '', ack: true });
        } catch (error) {
            if (error instanceof CancelledError) {
                this.clearTickTimer();
                this.remainingSecs = 0;
                await this.setRunningState(false, 0);
                return;
            }
            // The hardware command itself failed (e.g. STATE could not be set): roll
            // back the optimistically-set running/tick state from above so the valve
            // is not left claiming to run while nothing was actually started.
            this.clearTickTimer();
            this.remainingSecs = 0;
            const message = (error as Error).message;
            this.adapter.log.error(`Valve ${this.config.name}: failed to start: ${message}`);
            // Route the rollback through setRunningState() rather than duplicating its
            // pendingEchoCount++/setStateAsync("state") pair inline, so there is exactly
            // one place that credits an outstanding "state" echo - see the
            // pendingEchoCount field comment for why keeping this in sync matters.
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
    private otherSiblingRainbirdValveRunning(): boolean {
        const instance = rainbirdInstanceOf(this.config.stateId);
        if (!instance) {
            return false;
        }
        return this.getAllValves().some(
            other =>
                other !== this &&
                other.running &&
                other.config.type === 'Rainbird' &&
                rainbirdInstanceOf(other.config.stateId) === instance,
        );
    }

    /** Stop this valve immediately. */
    public async stop(): Promise<void> {
        if (!this.config.enabled) {
            if (this.running) {
                // The valve was disabled mid-run (e.g. via admin config): the hardware
                // command below cannot be trusted to still apply once re-enabled, but
                // the adapter must not keep reporting a valve as "running" forever with
                // no way to stop it through the adapter. Reconcile the bookkeeping so a
                // later stop()/start() is not left permanently stuck.
                this.clearTickTimer();
                this.remainingSecs = 0;
                await this.setRunningState(false, 0);
            }
            return;
        }
        this.clearTickTimer();
        this.remainingSecs = 0;
        this.running = false;
        let commandIssued = true;
        try {
            switch (this.config.type) {
                case 'Gardena':
                    await this.rateLimiter?.acquire(this.id);
                    await this.adapter.setForeignStateAsync(this.config.stateId, 'STOP_UNTIL_NEXT_TASK');
                    break;
                case 'Rainbird':
                    if (this.config.allOffId && !this.otherSiblingRainbirdValveRunning()) {
                        await this.adapter.setForeignStateAsync(this.config.allOffId, true);
                    } else if (!this.config.allOffId) {
                        // No allOffId configured: there is no hardware command this adapter
                        // can issue to actually close a Rainbird station, so the "stopped"
                        // status reported by setRunningState() below is not backed by any
                        // real command. Surface this loudly instead of silently claiming success.
                        commandIssued = false;
                        this.adapter.log.warn(
                            `Valve ${this.config.name}: cannot stop Rainbird valve - no allOffId configured. Reporting stopped in ioBroker only; the physical station may still be running.`,
                        );
                    }
                    break;
                case 'Hydrawise':
                    await this.adapter.setForeignStateAsync(
                        `${hydrawiseZoneBasePath(this.config.stateId)}.stopZone`,
                        true,
                    );
                    break;
                case 'Homematic':
                    // Reset ON_TIME first so the actuator does not re-arm itself from a
                    // stale timer value, then explicitly close the valve. ON_TIME is
                    // best-effort here for the same reason as in start(): some Homematic
                    // actuators expose it under a different name or not at all, and a
                    // failure here must not prevent the critical STATE=false command.
                    await this.setHomematicOnTime(0);
                    await this.adapter.setForeignStateAsync(`${this.config.stateId}.STATE`, false);
                    break;
                case 'Generic':
                    await this.adapter.setForeignStateAsync(this.config.stateId, false);
                    break;
            }
            if (commandIssued) {
                await this.setRunningState(false, 0);
            } else {
                // No hardware command could be issued to actually close the Rainbird
                // station: do NOT report "stopped" (running=false) here, since that
                // would make the admin UI show the valve as safely off while the
                // physical station may still be running. Keep `running` (and thus the
                // "state" datapoint) as-is and surface an error instead, so the user
                // can see the stop was not verified.
                this.running = true;
                await this.adapter.setStateAsync(`${this.id}.errorLast`, {
                    val: 'Stop requested but no allOffId configured - physical Rainbird station may still be running. Valve state left unchanged.',
                    ack: true,
                });
            }
        } catch (error) {
            if (error instanceof CancelledError) {
                return;
            }
            const message = (error as Error).message;
            this.adapter.log.error(`Valve ${this.config.name}: failed to stop: ${message}`);
            // Unlike start()'s catch block, no "state" echo is written here and
            // pendingEchoCount is left untouched: `running` was already flipped to
            // false synchronously at the top of this method, before the hardware
            // command was attempted, so there is no optimistic "running" status to
            // roll back and no extra echo to account for.
            await this.adapter.setStateAsync(`${this.id}.errorLast`, { val: message, ack: true });
        }
    }

    /**
     * Ticks remainingDuration down every second for adapter-owned timer types
     * (Homematic/Generic) and for Gardena valves (whose
     * duration_leftover_i is only pushed by smartgarden every 60 s).
     *
     * For Homematic/Generic the tick is the single source of truth for the
     * auto-stop. For Gardena the tick stops counting at 0 without calling
     * stop() — the Gardena device closes the valve itself.
     */
    private scheduleTick(): void {
        this.clearTickTimer();
        this.tickTimer = this.adapter.setInterval(() => {
            this.remainingSecs = Math.max(0, this.remainingSecs - 1);
            this.adapter
                .setStateAsync(`${this.id}.remainingDuration`, { val: this.remainingSecs, ack: true })
                .catch(error =>
                    this.adapter.log.warn(
                        `Valve ${this.config.name}: failed to update remainingDuration: ${(error as Error).message}`,
                    ),
                );
            this.adapter
                .setStateAsync(`${this.id}.remainingDurationMin`, {
                    val: formatDuration(this.remainingSecs),
                    ack: true,
                })
                .catch(error =>
                    this.adapter.log.warn(
                        `Valve ${this.config.name}: failed to update remainingDurationMin: ${(error as Error).message}`,
                    ),
                );
            if (this.remainingSecs <= 0) {
                this.clearTickTimer();
                this.commandChain = this.commandChain
                    .then(() => (this.config.type === 'Gardena' ? this.setRunningState(false, 0) : this.stop()))
                    .catch(error => {
                        if (error instanceof CancelledError) {
                            return;
                        }
                        this.adapter.log.error(
                            `Valve ${this.config.name}: auto-stop at remainingDuration=0 failed: ${(error as Error).message}`,
                        );
                    });
            }
        }, 1000);
    }

    private clearTickTimer(): void {
        if (this.tickTimer) {
            this.adapter.clearInterval(this.tickTimer);
            this.tickTimer = undefined;
        }
    }

    /** Remaining seconds, computed for adapter-owned timer types and Gardena. */
    public getRemainingSecs(): number {
        if (this.config.type === 'Homematic' || this.config.type === 'Generic' || this.config.type === 'Gardena') {
            return this.remainingSecs;
        }
        return 0;
    }

    /** Called on unload/onUnload to release adapter-owned timers. */
    public destroy(): void {
        this.clearTickTimer();
    }
}
