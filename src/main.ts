/*
 * ioBroker Irrigation Adapter
 * See plans/irrigation-adapter-plan.md for the full design.
 */

import * as utils from '@iobroker/adapter-core';
import { normalizeConfig } from './lib/config-defaults';
import { formatDuration } from './lib/duration';
import type { IPlanConfig, IrrigationNativeConfig, IValveConfig, ScanType } from './lib/types';
import { formatValveNumber, NONE_SENTINEL, parsePlanValveTableRows, synchronizePlanWithValves } from './lib/types';
import { createBaseStates, applyConfigToStates } from './lib/states';
import { ValveController } from './lib/ventile';
import { AutomationEngine } from './lib/automation';
import { Scheduler, resolvePlanFromIcalTitle, sortTimerTimes } from './lib/scheduler';
import { SensorManager } from './lib/sensors';
import { WindMonitor } from './lib/wind';
import { DwdRestriction } from './lib/dwd';
import { DWD_POI_STATIONS } from './lib/dwd-poi-stations';
import { WaterConsumptionTracker } from './lib/water-consumption';
import { WeatherApi } from './lib/weather-api';
import { NotificationManager } from './lib/notifications';
import { CALIBRATION_DURATION_SECS, FlowMonitor } from './lib/flow-monitor';
import { scanForValves } from './lib/valvescanner';
import { RateLimiter } from './lib/rate-limiter';

/**
 * Extracts the `_editPlan` plan index from a sendTo message payload.
 *
 * The admin UI's `jsonData` templates serialize a missing/never-selected
 * dropdown value as JSON `null` (via `JSON.stringify(data._editPlan ?? null)`,
 * see admin/jsonConfig.json) rather than omitting the key entirely, so this
 * helper treats `null` the same as `undefined` - both mean "no plan
 * selected". Without this, `null < 0` and `null >= length` both evaluate to
 * `false` in JavaScript, which would let a `null` index slip past the
 * `planIndex === undefined || planIndex < 0 || ...` checks used everywhere
 * else and be treated as if it were a valid index.
 *
 * @param message
 */
function readPlanIndex(message: unknown): number | undefined {
    const value = (message as Record<string, unknown> | undefined)?._editPlan;
    return typeof value === 'number' ? value : undefined;
}

/**
 * Safely reads and trims the `planName` field of a `sendTo` message payload.
 * `sendTo` messages can originate from any adapter/script with access to the
 * message bus (not just the admin UI), so the payload shape must not be
 * trusted - a non-string `planName` (e.g. a number or object) must not throw
 * inside `onMessage`.
 *
 * @param message
 */
function readPlanName(message: unknown): string | undefined {
    const value = (message as Record<string, unknown> | undefined)?.planName;
    return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * Key-order-independent structural (deep) equality check for two JSON-like
 * values (plain objects, arrays, and primitives - e.g. IPlanConfig/IValveConfig
 * entries). Used instead of JSON.stringify comparison, since JSON.stringify is
 * sensitive to property insertion order and can report two structurally
 * identical objects as different, causing unnecessary (and potentially
 * repeated/looping) native config migrations or plan-state rewrites.
 *
 * Keys whose value is `undefined` are treated as absent on both sides, since
 * `{...obj, allOffId: undefined}`-style spreads (as done by normalizeConfig)
 * create an explicit `undefined`-valued key that a plain object literal
 * without that key does not have, which would otherwise report a spurious
 * difference (`Object.keys` length mismatch) between an already-migrated
 * value and its freshly recomputed counterpart.
 *
 * @param a
 * @param b
 */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a !== typeof b) {
        return false;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }
        return a.every((item, index) => deepEqual(item, b[index]));
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
        const aObj = a as Record<string, unknown>;
        const bObj = b as Record<string, unknown>;
        const aKeys = Object.keys(aObj).filter(key => aObj[key] !== undefined);
        const bKeys = Object.keys(bObj).filter(key => bObj[key] !== undefined);
        if (aKeys.length !== bKeys.length) {
            return false;
        }
        return aKeys.every(key => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]));
    }
    // Different primitives (including one being null/undefined and the other
    // not, already excluded by the `a === b` check above) or NaN.
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
}

class Irrigation extends utils.Adapter {
    private config2!: IrrigationNativeConfig;
    private valves: ValveController[] = [];
    private automation!: AutomationEngine;
    private scheduler!: Scheduler;
    private sensorManager!: SensorManager;
    private windMonitor!: WindMonitor;
    private dwd!: DwdRestriction;
    private waterConsumption!: WaterConsumptionTracker;
    private weatherApi!: WeatherApi;
    private notifications!: NotificationManager;
    private flowMonitor!: FlowMonitor;
    private rateLimiter!: RateLimiter;
    private rateLimiterPoll: ReturnType<ioBroker.Adapter['setInterval']> | undefined;
    private scanProgressClearTimer: ReturnType<ioBroker.Adapter['setTimeout']> | undefined;
    private isScanning = false;
    /**
     * False until onReady() has fully finished constructing/initializing every
     * dependency (automation, valves, sensors, etc.). On a system with many
     * configured valves and/or a slow/unresponsive DWD or weather API, this
     * full startup sequence can take many seconds. subscribeStates() is
     * called as the very first thing in onReady() (see there) so no command
     * write is ever silently lost, but the command handlers below still need
     * `this.automation`/`this.valves` etc. to exist - any ack=false command
     * that arrives before that is queued here (see pendingEarlyCommands)
     * instead of either crashing (TypeError on an undefined dependency) or
     * being dropped, and is replayed once onReady() completes.
     */
    private isFullyReady = false;
    private readonly pendingEarlyCommands: { id: string; state: ioBroker.State }[] = [];

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'irrigation',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        try {
            await this.onReadyInner();
        } catch (error) {
            // If onReadyInner() throws before reaching `isFullyReady = true` (e.g. a
            // hard failure in dwd.init()/weatherApi.init()), any commands already
            // queued in pendingEarlyCommands (see the field comment) are about to be
            // discarded - the process will exit/restart and this in-memory queue does
            // not survive that. Surface that loss explicitly at error level (matching
            // the severity of the crash itself) rather than leaving only the earlier,
            // easy-to-miss per-command "queuing" log line as the only trace of a
            // real-world command (e.g. "Start") that never actually ran.
            if (this.pendingEarlyCommands.length > 0) {
                this.log.error(
                    `Adapter startup failed with ${this.pendingEarlyCommands.length} command(s) still queued and now lost: ` +
                        `${this.pendingEarlyCommands.map(c => c.id).join(', ')}`,
                );
            }
            throw error;
        }
    }

    private async onReadyInner(): Promise<void> {
        // Subscribe as the very first thing, before any other (possibly slow) async
        // initialization below - migrateNativeConfig, cleanupStale*, createBaseStates,
        // the per-valve init() loop (can be significant with many configured valves),
        // and especially dwd.init()/weatherApi.init() (real network requests) can
        // together take many seconds on a loaded system. Until subscribeStates()
        // actually registers these patterns, ioBroker delivers a stateChange event for
        // them to no one - it does not queue or replay events from before the
        // subscription existed - so a command (e.g. "Start") sent in that window is
        // silently lost with no error and no log entry. See isFullyReady/
        // pendingEarlyCommands for how a command that arrives before the dependencies
        // these handlers need (this.automation, this.valves, ...) are constructed is
        // now queued and replayed instead of being dropped or throwing.
        this.subscribeStates('automation.*');
        this.subscribeStates('valves.*.manualStart');
        this.subscribeStates('valves.*.calibrateFlow');
        this.subscribeStates('valves.*.duration');
        this.subscribeStates('watchdog.testNotify');
        this.subscribeStates('valves.*.state');

        this.config2 = normalizeConfig(this.config);
        await this.migrateNativeConfig();
        await this.sortTimerTimesIfNeeded();
        await this.resetTriggerModeIfExpertModeDisabled();
        await this.cleanupStaleValveObjects();
        await this.cleanupStaleZoneObjects();

        await createBaseStates(this);
        await this.loadPlansState();
        await applyConfigToStates(this, this.config2);

        this.rateLimiter = new RateLimiter();
        await this.createRateLimitStates();

        this.valves = this.config2.valves.map(
            (valveConfig, index) =>
                new ValveController(
                    this,
                    index,
                    valveConfig,
                    this.rateLimiter,
                    () => this.valves,
                    requestedOn => this.automation.manualSetValveState(index, requestedOn),
                ),
        );
        for (const valve of this.valves) {
            await valve.init();
        }

        this.notifications = new NotificationManager({ adapter: this, getConfig: () => this.config2 });

        this.sensorManager = new SensorManager({
            adapter: this,
            getConfig: () => this.config2,
            onRainChange: raining => this.automation?.setRainPause(raining),
        });
        await this.sensorManager.init();

        this.windMonitor = new WindMonitor({
            adapter: this,
            getConfig: () => this.config2,
            onWindPauseChange: paused => this.automation?.setWindPause(paused) ?? Promise.resolve(),
        });
        await this.windMonitor.init();

        this.waterConsumption = new WaterConsumptionTracker({ adapter: this, getConfig: () => this.config2 });
        await this.waterConsumption.init();

        this.flowMonitor = new FlowMonitor({
            adapter: this,
            getConfig: () => this.config2,
            notifications: this.notifications,
            getRunningValveIndexes: () => this.valves.map((v, i) => (v.isRunning() ? i : -1)).filter(i => i >= 0),
        });
        await this.flowMonitor.init();

        this.automation = new AutomationEngine({
            adapter: this,
            getConfig: () => this.config2,
            valves: this.valves,
            isValveBlockedForAutoRun: valveIndex => this.sensorManager.isValveBlocked(valveIndex),
            isLegallyRestricted: () => this.dwd.isActive(),
            isRaining: () => this.sensorManager.isRaining(),
            isWindOverLimit: () => this.windMonitor.isOverLimit(),
            getTemperatureAdjustmentTemperature: () => this.sensorManager.getTemperatureAdjustmentTemperature(),
            onValveFlowChange: (valveIndex, flowing) => this.waterConsumption.onValveFlowChange(valveIndex, flowing),
        });
        this.automation.start();
        await this.automation.recoverAfterRestart();

        this.dwd = new DwdRestriction({
            adapter: this,
            getConfig: () => this.config2,
            onRestrictionChanged: active => this.automation.onLegalRestrictionChanged(active),
        });
        await this.dwd.init();

        this.scheduler = new Scheduler({
            adapter: this,
            getConfig: () => this.config2,
            onTrigger: (planName, source) => this.handleSchedulerTrigger(planName, source),
            isFrostBlocked: () => this.sensorManager.isFrostBlocked(),
            isSeasonBlocked: () => this.sensorManager.isSeasonBlocked(),
        });
        await this.scheduler.init();

        this.weatherApi = new WeatherApi({ adapter: this, getConfig: () => this.config2 });
        await this.weatherApi.init();

        await this.setStateAsync('info.connection', { val: true, ack: true });

        this.rateLimiterPoll = this.setInterval(() => this.updateRateLimitStates(), 10_000);

        // Startup is now fully complete: replay any command that arrived (and was
        // queued, see isFullyReady/pendingEarlyCommands) while this method was still
        // running, in the order it was received.
        this.isFullyReady = true;
        const queued = this.pendingEarlyCommands.splice(0, this.pendingEarlyCommands.length);
        for (const { id, state } of queued) {
            this.log.info(`Replaying command for "${id}" that arrived while the adapter was still starting up.`);
            await this.onStateChange(id, state);
        }
    }

    /**
     * Persists newly introduced or migrated valve config fields.
     * plus a display-only "valveNumber" (e.g. "valve_2") back into `native` so the
     * admin config table shows real, editable/readable values for existing entries
     * instead of blanks. Only writes when something actually changed, since
     * updating our own instance's `native` triggers an adapter restart.
     *
     * Also assigns each pre-existing valve a stable `id` (defaulting to its
     * current array index, so its real object id/state history is preserved
     * across the upgrade - see the `IValveConfig.id` doc comment) and
     * initializes `nextValveId` so future newly-added valves get ids that
     * never collide with or get reused from an existing one.
     */
    private async migrateNativeConfig(): Promise<void> {
        const rawValves = (this.config as unknown as { valves?: Record<string, unknown>[] }).valves ?? [];
        const formattedValves = this.formatValvesForNative(this.config2.valves);
        const migratedValves = formattedValves.map((valve, index) => ({
            ...valve,
            valveNumber: `valve_${formatValveNumber(this.config2.valves[index].id ?? index)}`,
        }));
        const needsIdMigration = rawValves.some(raw => typeof raw.id !== 'number');
        const needsValveMigration =
            rawValves.length !== migratedValves.length ||
            rawValves.some(raw => !raw.valveNumber || 'runFor' in raw || typeof raw.duration === 'number') ||
            needsIdMigration;

        if (needsValveMigration) {
            this.log.info('Migrating native.valves to remove runFor, include valveNumber and stable id.');
            const maxAssignedId = this.config2.valves.reduce((max, valve) => Math.max(max, valve.id ?? -1), -1);
            const nextValveId = Math.max(this.config2.nextValveId, maxAssignedId + 1);
            await this.writeNativeAsync({ valves: migratedValves as unknown as IValveConfig[], nextValveId });
        }
    }

    /**
     * Self-heals an already-saved `scheduler.timerTimes` value that is not in
     * ascending time-of-day order, e.g. because it was saved before the admin
     * UI's live chip-input re-sort existed (see admin/jsonConfig.json's
     * onChange.calculateFunc on "scheduler.timerTimes"), or entered directly
     * via the Objects tab or a script. That admin-side fix only re-sorts the
     * displayed* chips the next time a chip is added/removed in an already
     * open config dialog - it never rewrites a value that was already saved
     * out of order, so re-opening the config dialog without editing anything
     * would otherwise keep showing the old, unsorted order indefinitely.
     * Rewriting the underlying native config here, once, at every adapter
     * start, ensures the admin UI shows the corrected order the next time it
     * reads the object (which happens right after this write triggers the
     * unconditional adapter restart that any native config write causes).
     */
    private async sortTimerTimesIfNeeded(): Promise<void> {
        const current = this.config2.scheduler.timerTimes;
        const sorted = sortTimerTimes(current);
        if (deepEqual(current, sorted)) {
            return;
        }
        this.log.info(`Sorting scheduler.timerTimes into ascending time-of-day order: [${sorted.join(', ')}].`);
        await this.writeNativeAsync({ scheduler: { ...this.config2.scheduler, timerTimes: sorted } });
    }

    /**
     * The iCal trigger mode is an expert-only feature: the admin UI hides the
     * "Trigger mode" selector and every iCal-related field, forcing timer mode,
     * whenever Expert mode is off (see admin/jsonConfig.json). `this.config2`
     * (built by normalizeConfig()) already reflects this at runtime regardless
     * of what is still saved, so scheduling itself is never affected by this
     * method running late or not at all.
     *
     * This method instead heals the underlying native config so the admin UI
     * shows "Timer times" instead of the actual, now-unreachable "iCal
     * calendar" option the next time the settings dialog is opened - e.g.
     * after a user who had iCal configured while Expert mode was on later
     * turns Expert mode off again without touching the (now hidden) trigger
     * mode selector itself.
     */
    private async resetTriggerModeIfExpertModeDisabled(): Promise<void> {
        if (this.config2.expertMode || this.config2.scheduler.triggerMode === 'timer') {
            return;
        }
        this.log.info(
            'Expert mode is off; resetting scheduler.triggerMode from "ical" to "timer" (iCal trigger mode requires Expert mode).',
        );
        await this.writeNativeAsync({ scheduler: { ...this.config2.scheduler, triggerMode: 'timer' } });
    }

    /**
     * Loads `plans` from the dedicated `automation.plansData` state into
     * `this.config2.plans`, migrating the legacy `native.plans` value into
     * that state once if the state doesn't hold anything useful yet.
     *
     * Plans are intentionally NOT stored in `native` config (unlike every
     * other setting): the admin UI's Plans tab lets users add/delete plans
     * and (re)assign valves via `sendTo` buttons while the settings dialog
     * is open, and writing to native config always triggers a full adapter
     * instance restart (this is unconditional js-controller behavior,
     * regardless of write method). Restarting mid-edit breaks the "Selected
     * plan" dropdown: its option list re-fetch can land in the brief window
     * where `alive` is `false` during the restart, after which nothing
     * re-triggers the fetch, leaving the dropdown empty until the page is
     * reloaded. A plain adapter state write never restarts the adapter, so
     * `plans` lives there instead. Must run after createBaseStates() (which
     * creates `automation.plansData`) and before anything that reads
     * `this.config2.plans`.
     */
    private async loadPlansState(): Promise<void> {
        const plansState = await this.getStateAsync('automation.plansData');
        const storedPlans = this.parsePlansState(plansState?.val);

        if (storedPlans && storedPlans.length > 0) {
            const synchronizedPlans = this.synchronizePlansWithValves(storedPlans);
            this.log.debug(`Loaded ${synchronizedPlans.length} plan(s) from automation.plansData.`);
            const hasLegacyFields = this.plansStateHasLegacyFields(plansState?.val);
            if (hasLegacyFields || !deepEqual(synchronizedPlans, storedPlans)) {
                if (hasLegacyFields) {
                    this.log.info('Removing legacy fields (e.g. valveOrder) from automation.plansData.');
                }
                await this.writePlansState(synchronizedPlans);
            } else {
                this.config2.plans = synchronizedPlans;
                await this.publishPlanNames(synchronizedPlans);
            }
            return;
        }

        // No usable state yet - this is either a fresh install (config2.plans
        // is already the normalized default "Alle" plan) or an existing
        // installation upgrading from a version that stored plans in
        // native.plans. Either way, seed the state from the current
        // this.config2.plans (already normalized from native by
        // normalizeConfig()) so it becomes the source of truth going forward.
        this.log.info('Initializing automation.plansData state from existing configuration.');
        await this.writePlansState(this.config2.plans);
    }

    private parsePlansState(raw: unknown): IPlanConfig[] | undefined {
        if (typeof raw !== 'string' || !raw) {
            return undefined;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return undefined;
            }
            return parsed.map((p: Partial<IPlanConfig>) => ({
                name: p?.name ?? '',
                valveIndexes: Array.isArray(p?.valveIndexes) ? p.valveIndexes : [],
                valveStateIds: Array.isArray(p?.valveStateIds) ? p.valveStateIds : undefined,
                knownValveStateIds: Array.isArray(p?.knownValveStateIds) ? p.knownValveStateIds : undefined,
            }));
        } catch (err) {
            this.log.warn(`Failed to parse automation.plansData state, ignoring: ${(err as Error).message}`);
            return undefined;
        }
    }

    /**
     * True if the raw automation.plansData JSON contains fields that are no
     * longer part of IPlanConfig (e.g. the legacy `valveOrder`/`valveOrderStateIds`
     * arrays used by an earlier per-plan ordering implementation). parsePlansState()
     * silently drops such fields when parsing into memory, so comparing the
     * in-memory representation before/after synchronization would never detect
     * them and the stale fields would otherwise linger in the persisted state
     * forever. Used by loadPlansState() to force one cleanup rewrite.
     *
     * @param raw
     */
    private plansStateHasLegacyFields(raw: unknown): boolean {
        if (typeof raw !== 'string' || !raw) {
            return false;
        }
        const knownFields = new Set<keyof IPlanConfig>(['name', 'valveIndexes', 'valveStateIds', 'knownValveStateIds']);
        try {
            const parsed = JSON.parse(raw);
            return (
                Array.isArray(parsed) &&
                parsed.some(
                    (p: unknown) =>
                        typeof p === 'object' &&
                        p !== null &&
                        Object.keys(p).some(key => !knownFields.has(key as keyof IPlanConfig)),
                )
            );
        } catch {
            return false;
        }
    }

    private synchronizePlansWithValves(plans: IPlanConfig[]): IPlanConfig[] {
        const currentStateIds = this.config2.valves.map(valve => valve.stateId);
        return plans.map(plan => synchronizePlanWithValves(plan, currentStateIds));
    }

    /**
     * Persists `plans` to the `automation.plansData` state and refreshes
     * `this.config2.plans` in-memory. Deliberately does NOT touch `native`
     * config - see loadPlansState() for why. Also mirrors the plan names
     * into automation.plansList (as before) so any external consumers of
     * that JSON state keep working unchanged.
     *
     * @param plans
     */
    private async writePlansState(plans: IPlanConfig[]): Promise<void> {
        const synchronizedPlans = this.synchronizePlansWithValves(plans);
        this.config2.plans = synchronizedPlans;
        this.log.debug(`Persisting ${synchronizedPlans.length} plan(s) to automation.plansData.`);
        await this.setStateAsync('automation.plansData', { val: JSON.stringify(synchronizedPlans), ack: true });
        await this.publishPlanNames(synchronizedPlans);
    }

    private async publishPlanNames(plans: IPlanConfig[]): Promise<void> {
        const planNames = plans.map(plan => plan.name);
        const states = Object.fromEntries(planNames.map(planName => [planName, planName]));
        await this.setStateAsync('automation.plansList', { val: JSON.stringify(planNames), ack: true });
        // `extendObject` deep-merges `common.states` instead of replacing it, so
        // removed/renamed plans would otherwise keep lingering as selectable
        // values forever. Replace the whole `states` map explicitly instead.
        await this.replaceObjectStates('automation.planSelect', states);
        await this.replaceObjectStates('automation.startPlan', states);
    }

    /**
     * Fully replaces `common.states` on the given object instead of merging
     * it, since `extendObjectAsync` deep-merges nested objects and would
     * otherwise never drop keys for plans that were deleted or renamed.
     *
     * @param id
     * @param states
     */
    private async replaceObjectStates(id: string, states: Record<string, string>): Promise<void> {
        const obj = await this.getObjectAsync(id);
        if (!obj) {
            return;
        }
        obj.common = { ...obj.common, states };
        await this.setObjectAsync(id, obj);
    }

    /**
     * Creates the smartgarden rate limit monitoring states.
     */
    private async createRateLimitStates(): Promise<void> {
        await this.setObjectNotExistsAsync('smartgardenRateLimit', {
            type: 'channel',
            common: { name: 'Smartgarden API rate limit' },
            native: {},
        });
        await this.setObjectNotExistsAsync('smartgardenRateLimit.window10sCount', {
            type: 'state',
            common: {
                name: 'Requests in 10s window',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('smartgardenRateLimit.weeklyCount', {
            type: 'state',
            common: {
                name: 'Requests in 7-day window',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('smartgardenRateLimit.lastRequest', {
            type: 'state',
            common: {
                name: 'Timestamp of last request (ms epoch)',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('smartgardenRateLimit.nextSlot', {
            type: 'state',
            common: {
                name: 'Timestamp when next slot opens (ms epoch, 0 = now)',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('smartgardenRateLimit.queueLength', {
            type: 'state',
            common: {
                name: 'Number of pending requests in queue',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
    }

    private async updateRateLimitStates(): Promise<void> {
        const state = this.rateLimiter.getState();
        await this.setStateAsync('smartgardenRateLimit.window10sCount', { val: state.window10sCount, ack: true });
        await this.setStateAsync('smartgardenRateLimit.weeklyCount', { val: state.weeklyCount, ack: true });
        await this.setStateAsync('smartgardenRateLimit.lastRequest', { val: state.lastRequest, ack: true });
        await this.setStateAsync('smartgardenRateLimit.nextSlot', { val: state.nextSlot, ack: true });
        await this.setStateAsync('smartgardenRateLimit.queueLength', { val: state.queueLength, ack: true });
    }

    /**
     * Deletes leftover `valves.valve_N` objects (and their child states) that no
     * longer correspond to any entry in the current `native.valves` config.
     * This covers two cases:
     *
     *  1. Objects whose numeric suffix is not zero-padded to 3 digits, i.e.
     *     objects created before valve object ids were changed from
     *     `valves.valve_0` to `valves.valve_000`.
     *  2. Objects whose (zero-padded) index is >= the number of valves
     *     currently configured, i.e. leftovers from a previous, larger valve
     *     list (e.g. after a re-scan found fewer valves, or rows were removed
     *     from the Valves table in admin). Without this, the orphaned object
     *     keeps reacting to nothing (no ValveController is created for it
     *     anymore) while still looking like a normal, configured valve to the
     *     user - this was reported as "changing valve_054.state does nothing"
     *     after the valve list shrank from 61 to 50 entries and that
     *     particular valve (now valve_043) kept its old id around.
     *
     * ValveController.init() only ever creates/updates the ids for valves
     * still present in the config via setObjectNotExistsAsync/extendObjectAsync,
     * so without this cleanup both kinds of stale objects are left behind as
     * orphans indefinitely.
     *
     * Safety: case 2 is skipped entirely when the config's valve list is
     * empty. An empty list at this point could mean the user genuinely
     * deleted all valves, but it is indistinguishable here from `this.config`
     * transiently/erroneously arriving empty (e.g. a stale/partial adapter
     * config read). Since "Delete all valves" in admin already removes the
     * objects itself, skipping the range-based cleanup on an empty list only
     * risks leaving orphans around a little longer in the rare genuine-empty
     * case, whereas NOT skipping it risks wiping out every valve object
     * (losing calibration/state history) on a transient empty read - a much
     * worse outcome that was observed in practice.
     */
    private async cleanupStaleValveObjects(): Promise<void> {
        const channels = await this.getForeignObjectsAsync(`${this.namespace}.valves.*`, 'channel');
        const stalePattern = /^valves\.valve_(\d+)$/;
        const configuredValveCount = this.config2.valves.length;
        const checkRange = configuredValveCount > 0;
        for (const id of Object.keys(channels)) {
            const localId = id.slice(this.namespace.length + 1);
            const match = stalePattern.exec(localId);
            if (!match) {
                continue;
            }
            const isUnpadded = match[1].length !== 3;
            const isOutOfRange = checkRange && parseInt(match[1], 10) >= configuredValveCount;
            if (isUnpadded || isOutOfRange) {
                const reason = isUnpadded
                    ? 'un-padded legacy id'
                    : `index >= configured valve count (${configuredValveCount})`;
                this.log.info(`Removing stale valve object "${id}" (${reason}).`);
                await this.delObjectAsync(localId, { recursive: true }).catch(error =>
                    this.log.warn(`Failed to remove stale valve object "${id}": ${(error as Error).message}`),
                );
            }
        }
    }

    /**
     * Removes legacy zone objects (zones.*) — zones were removed in v0.2.0.
     */
    private async cleanupStaleZoneObjects(): Promise<void> {
        try {
            await this.delObjectAsync('zones', { recursive: true });
            this.log.info('Removed legacy zone objects (zones removed in v0.2.0).');
        } catch {
            // zones channel may not exist — that's fine
        }
    }

    private async handleSchedulerTrigger(planName: string, source: 'timer' | 'ical'): Promise<void> {
        if (source === 'ical') {
            const activeTitle = await this.tryResolveIcalTitle();
            if (activeTitle) {
                planName = resolvePlanFromIcalTitle(
                    activeTitle,
                    this.config2.scheduler.icalTitlePrefix,
                    this.config2.plans.map(p => p.name),
                    this.config2.plans[0]?.name ?? 'All',
                );
            }
        }
        await this.automation.requestRun(planName, source);
    }

    private async tryResolveIcalTitle(): Promise<string | undefined> {
        const icalInstance = this.config2.scheduler.icalAdapterInstance;
        if (!icalInstance) {
            return undefined;
        }

        try {
            const dataTable = await this.getForeignStateAsync(`${icalInstance}.data.table`);
            const raw = dataTable?.val;
            if (typeof raw !== 'string' || !raw) {
                return undefined;
            }

            const events = JSON.parse(raw) as { event?: string; _date?: string; _end?: string }[];
            if (!Array.isArray(events)) {
                return undefined;
            }

            const prefixLower = this.config2.scheduler.icalTitlePrefix.toLowerCase();
            const now = Date.now();
            let best: { event: string; start: number } | undefined;

            for (const evt of events) {
                if (!evt.event || typeof evt.event !== 'string') {
                    continue;
                }
                if (!evt.event.toLowerCase().startsWith(prefixLower)) {
                    continue;
                }
                const startTs = evt._date ? new Date(evt._date).getTime() : NaN;
                const endTs = evt._end ? new Date(evt._end).getTime() : NaN;
                if (isNaN(startTs) || isNaN(endTs)) {
                    continue;
                }
                if (now < startTs || now >= endTs) {
                    continue;
                }
                if (!best || startTs < best.start) {
                    best = { event: evt.event, start: startTs };
                }
            }

            return best?.event;
        } catch (error) {
            this.log.warn(`Failed to resolve ical event title: ${(error as Error).message}`);
            return undefined;
        }
    }

    /**
     * Runs a single cleanup step, logging (but never throwing) any error so
     * that one module's failed destroy() can never prevent the cleanup of
     * all subsequent modules. Awaits the result in case destroy() ever
     * starts returning a Promise.
     *
     * @param label Name of the module being destroyed, used in the log message.
     * @param destroyFn The cleanup callback to run.
     */
    private async safeDestroy(label: string, destroyFn: () => void | Promise<void>): Promise<void> {
        try {
            await destroyFn();
        } catch (error) {
            this.log.error(`Error destroying ${label} during unload: ${(error as Error).message}`);
        }
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.rateLimiterPoll) {
                this.clearInterval(this.rateLimiterPoll);
                this.rateLimiterPoll = undefined;
            }
            if (this.scanProgressClearTimer) {
                this.clearTimeout(this.scanProgressClearTimer);
                this.scanProgressClearTimer = undefined;
            }
            await this.safeDestroy('rateLimiter', () => this.rateLimiter?.destroy());
            await this.safeDestroy('automation', () => this.automation?.destroy());
            await this.safeDestroy('scheduler', () => this.scheduler?.destroy());
            await this.safeDestroy('dwd', () => this.dwd?.destroy());
            await this.safeDestroy('windMonitor', () => this.windMonitor?.destroy());
            await this.safeDestroy('weatherApi', () => this.weatherApi?.destroy());
            await this.safeDestroy('flowMonitor', () => this.flowMonitor?.destroy());
            await this.safeDestroy('sensorManager', () => this.sensorManager?.destroy());
            for (const valve of this.valves) {
                await this.safeDestroy(`valve ${valve.id}`, () => valve.destroy());
            }
        } catch (error) {
            this.log.error(`Error during unloading: ${(error as Error).message}`);
        } finally {
            callback();
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        try {
            await this.handleStateChange(id, state);
        } catch (error) {
            this.log.error(`Error handling state change for "${id}": ${(error as Error).message}`);
        }
    }

    private async handleStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state) {
            return;
        }

        // Foreign state changes (valves, sensors, ical trigger, flow sensors)
        if (!id.startsWith(`${this.namespace}.`)) {
            // Each valve's onForeignStateChange() is internally safe to run
            // concurrently: matching actions are chained onto that valve's own
            // commandChain and any error is caught and logged there (see
            // ValveController.onForeignStateChange()/commandChain). Running them
            // in parallel (instead of sequentially awaiting each one) means a
            // rejected/slow handler for one valve can no longer delay or block
            // delivery of this foreign state change to the other valves.
            const matches = await Promise.all(
                this.valves.map(valve =>
                    valve.onForeignStateChange(id, state).catch(error => {
                        this.log.error(
                            `Valve ${valve.id}: error handling foreign state change for "${id}": ${(error as Error).message}`,
                        );
                        return false;
                    }),
                ),
            );
            if (matches.some(matched => matched)) {
                return;
            }
            const handledBySensor = (await this.sensorManager?.onForeignStateChange(id, state)) ?? false;
            const handledByWind = (await this.windMonitor?.onForeignStateChange(id, state)) ?? false;
            const handledByRestriction = (await this.dwd?.onForeignStateChange(id, state)) ?? false;
            if (handledBySensor || handledByWind || handledByRestriction) {
                return;
            }
            if (await this.scheduler?.onForeignStateChange(id, state)) {
                return;
            }
            if (await this.flowMonitor?.onForeignStateChange(id, state)) {
                return;
            }
            return;
        }

        const localId = id.slice(this.namespace.length + 1);

        // Valve "state" (on/off) is special-cased before the general ack=true
        // filter below: the admin "Objects" tab edits a state's value directly
        // and, depending on the admin version, may submit that edit with
        // ack=true instead of ack=false. From the user's perspective this is
        // still an explicit "turn this valve on/off" command, so it must reach
        // ValveController.onOwnStateChange() regardless of the ack flag; that
        // method itself guards against feedback loops from our own status
        // echoes (see its docstring).
        const valveStateMatch = /^valves\.valve_\d+\.state$/.exec(localId);

        // subscribeStates() is registered as the very first thing in onReady() (see
        // there) specifically so that no command write is ever silently lost, but
        // the handlers below need `this.automation`/`this.valves`/etc. to actually
        // exist. If onReady() has not finished yet (can take many seconds with many
        // configured valves and/or a slow DWD/weather API), queue a genuine incoming
        // command instead of either dropping it or crashing on an undefined
        // dependency; onReady() replays every queued command, in order, once it
        // completes (see isFullyReady/pendingEarlyCommands).
        //
        // Only ack=false writes are deferred here - NOT ack=true writes to
        // "valves.*.state" (the valveStateMatch special case above), even though
        // those are otherwise treated as commands too (see the comment above
        // valveStateMatch). The overwhelming majority of ack=true "state" writes are
        // this adapter's OWN status echoes, most notably ValveController's initial
        // echo written by setRunningState() during valve.init() - which itself runs
        // in the per-valve init loop in onReady(), before isFullyReady is set. That
        // echo handling is self-contained (governed entirely by ValveController's
        // own pendingEchoCount/commandChain, see ventile.ts) and does not depend on
        // `this.automation` or any other not-yet-constructed dependency, so there is
        // no need to defer it - doing so anyway would needlessly queue and replay a
        // duplicate, delayed pass through onOwnStateChange() for every configured
        // valve on every startup. The rare genuine command case (an admin editing
        // the Objects tab directly with ack=true, before the adapter has finished
        // starting) is not deferred either; if that reaches ValveController.start()/
        // stop() before `this.automation` exists, the resulting error is caught and
        // logged by the try/catch in onStateChange() rather than silently dropped,
        // which is an acceptable trade-off for this narrow edge case.
        if (!state.ack && !this.isFullyReady) {
            this.log.warn(`Adapter is still starting up - queuing command for "${id}" to run once startup completes.`);
            this.pendingEarlyCommands.push({ id, state });
            // "Start"/"Start plan" specifically is given immediate feedback via
            // automation.status - without this, a user pressing Start while the
            // adapter is still waiting on e.g. a slow/unresponsive weather or DWD
            // API request sees no visible reaction at all for however long startup
            // takes (this can be many seconds, see the isFullyReady field comment),
            // which looks exactly like the command did nothing. The real status text
            // (idle/running/paused/...) is published as usual once the command is
            // actually replayed and runPlan() runs for real.
            if (localId === 'automation.start' || localId === 'automation.startPlan') {
                await this.setStateAsync('automation.status', {
                    val: 'Mode: loading (Plan wird geladen - Adapter initialisiert noch)',
                    ack: true,
                });
            }
            return;
        }

        if (valveStateMatch) {
            for (const valve of this.valves) {
                if (await valve.onOwnStateChange(localId, state)) {
                    return;
                }
            }
            return;
        }

        if (state.ack) {
            return;
        } // only react to commands

        switch (localId) {
            case 'automation.start':
                await this.setStateAsync(id, { val: false, ack: true });
                await this.automation.requestRun(this.config2.plans[0]?.name ?? 'All', 'manual-button');
                return;
            case 'automation.startPlan': {
                const planName = typeof state.val === 'string' ? state.val.trim() : '';
                await this.setStateAsync(id, { val: '', ack: true });
                if (planName) {
                    await this.automation.requestRun(planName, 'manual-button');
                }
                return;
            }
            case 'automation.stop':
                await this.setStateAsync(id, { val: false, ack: true });
                await this.automation.stop();
                return;
            case 'automation.pause':
                await this.setStateAsync(id, { val: false, ack: true });
                await this.automation.pause();
                return;
            case 'automation.next':
                await this.setStateAsync(id, { val: false, ack: true });
                await this.automation.next();
                return;
            case 'automation.back':
                await this.setStateAsync(id, { val: false, ack: true });
                await this.automation.back();
                return;
            case 'automation.active':
                this.config2.scheduler.autoMode = state.val === true;
                // Re-evaluate the heat-pause restriction immediately instead
                // of waiting for its next periodic interval tick: it is now
                // gated on autoMode too (see dwd.ts isRestrictionEnabled()),
                // so toggling autoMode off must clear an active restriction
                // right away, and toggling it back on must resume evaluating
                // it right away, not minutes later.
                await this.dwd
                    .check()
                    .catch(error =>
                        this.log.error(
                            `Legal restriction re-check after autoMode change failed: ${(error as Error).message}`,
                        ),
                    );
                return;
            case 'automation.planSelect':
                return; // stored, used on next requestRun
            case 'watchdog.testNotify':
                await this.setStateAsync(id, { val: false, ack: true });
                await this.notifications.send('Bewässerung Test', 'Dies ist eine Testbenachrichtigung.');
                return;
        }

        const valveManualStartMatch = /^valves\.valve_(\d+)\.manualStart$/.exec(localId);
        if (valveManualStartMatch) {
            await this.setStateAsync(id, { val: false, ack: true });
            const valveIndex = this.findValveIndexByObjectSuffix(parseInt(valveManualStartMatch[1], 10));
            if (valveIndex >= 0) {
                await this.automation.manualStartValve(valveIndex);
            }
            return;
        }

        const valveCalibrateMatch = /^valves\.valve_(\d+)\.calibrateFlow$/.exec(localId);
        if (valveCalibrateMatch) {
            await this.setStateAsync(id, { val: false, ack: true });
            const valveIndex = this.findValveIndexByObjectSuffix(parseInt(valveCalibrateMatch[1], 10));
            if (valveIndex >= 0) {
                await this.flowMonitor.startCalibration(
                    valveIndex,
                    // Explicitly pass the calibration window's own duration rather than
                    // letting start() fall back to the valve's configured `duration`:
                    // if that configured duration were shorter than
                    // CALIBRATION_DURATION_SECS, the valve would auto-stop itself
                    // mid-calibration while flow-monitor keeps sampling (now zero
                    // flow) for the remainder of the window, skewing the average down.
                    () => this.valves[valveIndex].start(CALIBRATION_DURATION_SECS),
                    () => this.valves[valveIndex].stop(),
                );
            }
            return;
        }

        const valveMatch = /^valves\.valve_\d+\./.exec(localId);
        if (valveMatch) {
            for (const valve of this.valves) {
                if (await valve.onOwnStateChange(localId, state)) {
                    return;
                }
            }
            return;
        }
    }

    /**
     * Writes a partial `native` update directly to our own instance object instead of
     * using extendForeignObjectAsync or returning `{native, saveConfig: true}` via a
     * sendTo response (which would pop up an extra "Save configuration?" confirmation
     * dialog in the admin UI). Writing the object directly persists it immediately and
     * triggers the usual adapter restart, without that extra dialog.
     *
     * Uses a full read-modify-write (getForeignObjectAsync + setForeignObjectAsync)
     * rather than extendForeignObjectAsync: extendObject's underlying deep-merge
     * (node.extend) treats arrays as index-keyed maps, so merging a shorter (or
     * differently-shaped) array/object into an existing one does not fully replace it -
     * stale elements/fields would survive. That, in turn, can make the same "needs
     * migration" check keep matching true on every restart (since the stale data never
     * actually gets overwritten), causing the adapter to restart itself in a loop. A
     * full read-modify-write always replaces the given top-level native keys outright.
     *
     * @param partialNative
     */
    private async writeNativeAsync(partialNative: Partial<IrrigationNativeConfig>): Promise<void> {
        const instanceObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        if (instanceObj) {
            const mergedNative = { ...(instanceObj.native ?? {}), ...partialNative };
            instanceObj.native = mergedNative;
            await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instanceObj);
            // Keep the in-memory config in sync immediately. this.config/this.config2 are
            // otherwise only refreshed by a full adapter restart, which the js-controller
            // triggers asynchronously (and not always instantly) after a native config
            // write. Message handlers like listPlans run within the same adapter process
            // right after this write returns and must see the just-written data straight
            // away - without this, e.g. createPlan/deletePlan would keep reading the stale
            // this.config2.plans snapshot from adapter startup until a restart happened to
            // complete, which could make the "Selected plan" dropdown appear empty or
            // outdated after adding/removing a plan.
            this.config2 = normalizeConfig(mergedNative);
        }
    }

    /**
     * Converts valve durations (stored in `this.config2`/`IValveConfig` as
     * numeric seconds) back into the "HH:MM:SS"/"MM:SS" display string the
     * admin table's `duration`/`manualDuration` text fields expect (see
     * migrateNativeConfig() and admin/jsonConfig.json). Every write path that
     * persists valves to `native.valves` - or hands them back to an open
     * admin dialog via a `sendTo` response - must go through this so the
     * table never shows raw seconds.
     *
     * @param valves
     */
    private formatValvesForNative(valves: IValveConfig[]): Record<string, unknown>[] {
        return valves.map(valve => ({
            ...valve,
            duration: formatDuration(valve.duration),
            manualDuration: formatDuration(valve.manualDuration),
        }));
    }

    private async writeValvesToNative(valves: IValveConfig[]): Promise<void> {
        await this.writeNativeAsync({ valves: this.formatValvesForNative(valves) as unknown as IValveConfig[] });
    }

    /**
     * Maps the numeric suffix of a `valves.valve_NNN.*` object id back to the
     * valve's current array index in `this.config2.valves`/`this.valves`. The
     * object suffix is the valve's stable `id` (see `IValveConfig.id`), which
     * can differ from its current array position once valves have been
     * reordered/deleted/re-added - so this must never be used directly as an
     * array index.
     *
     * @param numericSuffix
     */
    private findValveIndexByObjectSuffix(numericSuffix: number): number {
        return this.config2.valves.findIndex((valve, index) => (valve.id ?? index) === numericSuffix);
    }

    private getPlanValveIndexes(planIndex: number | undefined): number[] {
        const plan =
            planIndex !== undefined && planIndex >= 0 && planIndex < this.config2.plans.length
                ? this.config2.plans[planIndex]
                : undefined;
        const allValveIndexes = this.config2.valves.map((_, index) => index);
        return plan && plan.valveIndexes.length === 0
            ? allValveIndexes
            : (plan?.valveIndexes ?? []).filter(index => index >= 0 && index < this.config2.valves.length);
    }

    private getPlanValveTable(planIndex: number | undefined): Array<{
        valveNumber: string;
        name: string;
        assigned: boolean;
    }> {
        const allValveIndexes = this.config2.valves.map((_, index) => index);
        const assignedIndexes = this.getPlanValveIndexes(planIndex);
        const assignedSet = new Set(assignedIndexes);
        return allValveIndexes.map(index => ({
            valveNumber: formatValveNumber(this.config2.valves[index].id ?? index),
            name: this.config2.valves[index].name || 'unnamed',
            assigned: assignedSet.has(index),
        }));
    }

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        try {
            await this.handleMessage(obj);
        } catch (error) {
            this.log.error(`Error handling message "${obj?.command}": ${(error as Error).message}`);
        }
    }

    private async handleMessage(obj: ioBroker.Message): Promise<void> {
        if (obj === null || typeof obj !== 'object' || !obj.command) {
            return;
        }

        if (obj.command === 'scanValves') {
            if (this.isScanning) {
                this.log.warn('Valve scan requested while another scan is still running - rejecting.');
                if (obj.callback) {
                    this.sendTo(
                        obj.from,
                        obj.command,
                        {
                            error: 'scanInProgress',
                            result: 'scanErrors',
                            errors: ['A valve scan is already running.'],
                        },
                        obj.callback,
                    );
                }
                return;
            }
            this.isScanning = true;
            try {
                await this.handleScanValves(obj);
            } finally {
                this.isScanning = false;
            }
            return;
        }

        if (obj.command === 'deleteValvesByStateId') {
            const rawStateIds = (obj.message as { stateIds?: unknown } | undefined)?.stateIds;
            const stateIds = Array.isArray(rawStateIds)
                ? rawStateIds.filter((v): v is string => typeof v === 'string')
                : [];
            const toRemove = new Set(stateIds);
            const before = this.config2.valves.length;
            const remaining = this.config2.valves.filter(v => !toRemove.has(v.stateId));
            const removedCount = before - remaining.length;
            this.log.info(`Removing ${removedCount} valve(s) by stateId from configuration`);

            if (removedCount > 0) {
                await this.writeValvesToNative(remaining);
            }

            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { removedCount }, obj.callback);
            }
            return;
        }

        if (obj.command === 'send' && obj.callback) {
            this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        }

        if (obj.command === 'listValves' && obj.callback) {
            const options = this.config2.valves.map((v, i) => ({
                label: `[${formatValveNumber(i)}] ${v.name || 'unnamed'}`,
                value: i,
            }));
            this.sendTo(obj.from, obj.command, options, obj.callback);
            return;
        }

        if (obj.command === 'listPlans' && obj.callback) {
            const options = this.config2.plans.map((p, i) => ({
                label: p.name || `Plan ${i}`,
                value: i,
            }));
            this.sendTo(obj.from, obj.command, options, obj.callback);
            return;
        }

        if (obj.command === 'listDwdStations' && obj.callback) {
            this.sendTo(
                obj.from,
                obj.command,
                [{ label: 'Keine Wetterstation', value: '' }, ...DWD_POI_STATIONS],
                obj.callback,
            );
            return;
        }

        if (obj.command === 'createPlan' && obj.callback) {
            const name = readPlanName(obj.message);
            if (!name) {
                this.sendTo(obj.from, obj.command, { error: 'noName' }, obj.callback);
                return;
            }
            if (this.config2.plans.some(plan => plan.name === name)) {
                this.sendTo(obj.from, obj.command, { error: 'nameExists' }, obj.callback);
                return;
            }
            const updatedPlans = [...this.config2.plans, { name, valveIndexes: [] }];
            const newPlanIndex = updatedPlans.length - 1;
            await this.writePlansState(updatedPlans);
            this.log.info(`Created new plan "${name}"`);
            // writePlansState() persists to the automation.plansData state, not to
            // native config, so this does NOT restart the adapter (see
            // loadPlansState()'s doc comment for why plans live in a state instead
            // of native.plans). The admin UI response below still uses the
            // "native: {...}" + useNative:true wrapper - that's purely a
            // client-side naming convention the json-config framework's ConfigSendto
            // component looks for to merge attributes into the live form state; it
            // has no effect on the adapter's real native config regardless of the
            // key name used.
            // Both "plans" and "_editPlan" are sent together in a single response
            // (unlike the two-step approach tried in 0.2.10/0.2.12, which avoided
            // this to prevent overlapping refetches back when plans still lived in
            // native config and every write triggered an adapter restart). Now that
            // plans live in automation.plansData and this.config2.plans is already
            // updated synchronously by writePlansState() above, a single merged
            // response is safe: the "Selected plan" dropdown's
            // alsoDependsOn: ["plans"] re-fetches its options via listPlans (which
            // reads the already-updated this.config2.plans), and "_editPlan" is set
            // here so the newly created plan is immediately selected instead of
            // leaving the previous (or no) selection in place.
            this.sendTo(
                obj.from,
                obj.command,
                { native: { plans: updatedPlans, _editPlan: newPlanIndex } },
                obj.callback,
            );
            return;
        }

        if (obj.command === 'renamePlan' && obj.callback) {
            const planIndex = readPlanIndex(obj.message);
            const name = readPlanName(obj.message);
            if (planIndex === undefined || planIndex < 0 || planIndex >= this.config2.plans.length) {
                this.sendTo(obj.from, obj.command, { error: 'noSelection' }, obj.callback);
                return;
            }
            if (!name) {
                this.sendTo(obj.from, obj.command, { error: 'noName' }, obj.callback);
                return;
            }
            if (this.config2.plans.some((plan, index) => index !== planIndex && plan.name === name)) {
                this.sendTo(obj.from, obj.command, { error: 'nameExists' }, obj.callback);
                return;
            }
            const oldName = this.config2.plans[planIndex].name;
            const updatedPlans = this.config2.plans.map((plan, index) =>
                index === planIndex ? { ...plan, name } : plan,
            );
            await this.writePlansState(updatedPlans);
            const selectedPlan = await this.getStateAsync('automation.planSelect');
            if (selectedPlan?.val === oldName) {
                await this.setStateAsync('automation.planSelect', { val: name, ack: true });
            }
            this.log.info(`Renamed plan "${oldName}" to "${name}"`);
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans, _editPlan: planIndex } }, obj.callback);
            return;
        }

        if (obj.command === 'deletePlan' && obj.callback) {
            const planIndex = readPlanIndex(obj.message);
            if (planIndex === undefined || planIndex < 0 || planIndex >= this.config2.plans.length) {
                this.sendTo(obj.from, obj.command, { error: 'noSelection' }, obj.callback);
                return;
            }
            if (this.config2.plans.length <= 1) {
                this.sendTo(obj.from, obj.command, { error: 'lastPlan' }, obj.callback);
                return;
            }
            const removedName = this.config2.plans[planIndex].name;
            const updatedPlans = this.config2.plans.filter((_, i) => i !== planIndex);
            const nextSelectedIndex = Math.min(planIndex, updatedPlans.length - 1);
            await this.writePlansState(updatedPlans);
            this.log.info(`Deleted plan "${removedName}"`);
            // See the comment in the createPlan handler above: writePlansState() does
            // not restart the adapter, and this.config2.plans is already updated
            // synchronously, so it's safe to send "plans" and "_editPlan" together
            // in one response. "_editPlan" is set to the plan that now occupies the
            // deleted plan's position (or the new last plan, if the last plan was
            // deleted) so the dropdown always keeps a valid selection instead of
            // pointing at an out-of-range or stale index.
            this.sendTo(
                obj.from,
                obj.command,
                { native: { plans: updatedPlans, _editPlan: nextSelectedIndex } },
                obj.callback,
            );
            return;
        }

        if (obj.command === 'loadPlanValveTable' && obj.callback) {
            const planIndex = readPlanIndex(obj.message);
            this.sendTo(
                obj.from,
                obj.command,
                { native: { planValveTable: this.getPlanValveTable(planIndex) } },
                obj.callback,
            );
            return;
        }

        if (obj.command === 'applyPlanValveTable' && obj.callback) {
            const msg = obj.message as Record<string, unknown>;
            const planIndex = readPlanIndex(msg);
            if (planIndex === undefined || planIndex < 0 || planIndex >= this.config2.plans.length) {
                this.sendTo(obj.from, obj.command, { error: 'noSelection' }, obj.callback);
                return;
            }
            const rawRows = msg?.planValveTable;
            const rows = Array.isArray(rawRows) ? (rawRows as Array<{ valveNumber?: string; assigned?: boolean }>) : [];
            const selectedIndexes = parsePlanValveTableRows(rows, this.config2.valves);
            const updatedPlans = this.config2.plans.map((p, i) =>
                i === planIndex
                    ? {
                          ...p,
                          valveIndexes: selectedIndexes.length > 0 ? selectedIndexes : [NONE_SENTINEL],
                          valveStateIds: selectedIndexes.map(index => this.config2.valves[index].stateId),
                          knownValveStateIds: this.config2.valves.map(valve => valve.stateId),
                      }
                    : p,
            );
            await this.writePlansState(updatedPlans);
            this.sendTo(
                obj.from,
                obj.command,
                { native: { plans: updatedPlans, planValveTable: this.getPlanValveTable(planIndex) } },
                obj.callback,
            );
            return;
        }

        if (obj.command === 'addAllValvesToAllPlans' && obj.callback) {
            const allValveIndexes = this.config2.valves.map((_, i) => i);
            const updatedPlans = this.config2.plans.map(p => ({
                ...p,
                valveIndexes: [...allValveIndexes],
                valveStateIds: this.config2.valves.map(valve => valve.stateId),
                knownValveStateIds: this.config2.valves.map(valve => valve.stateId),
            }));
            await this.writePlansState(updatedPlans);
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
            return;
        }

        if (obj.command === 'removeAllValvesFromAllPlans' && obj.callback) {
            const updatedPlans = this.config2.plans.map(p => ({
                ...p,
                valveIndexes: [NONE_SENTINEL],
                valveStateIds: [],
                knownValveStateIds: this.config2.valves.map(valve => valve.stateId),
            }));
            await this.writePlansState(updatedPlans);
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
            return;
        }
    }

    /**
     * Runs the actual valve scan for the `scanValves` message command. Split
     * out of handleMessage() so the isScanning guard there stays simple.
     * Bounded by a timeout so a hung foreign adapter/API can never leave
     * isScanning stuck forever (see the caller in handleMessage()).
     *
     * @param obj
     */
    private async handleScanValves(obj: ioBroker.Message): Promise<void> {
        const payload = obj.message as {
            type: ScanType;
            instance: string;
            instanceRainbird?: string;
            instanceHomematic?: string;
            instanceHydrawise?: string;
            locationId?: string;
        };
        let effectiveInstance: string;
        switch (payload.type) {
            case 'All':
                effectiveInstance = '';
                break;
            case 'Homematic':
                effectiveInstance = payload.instanceHomematic ?? '';
                break;
            case 'Rainbird':
                effectiveInstance = payload.instanceRainbird ?? '';
                break;
            case 'Hydrawise':
                effectiveInstance = payload.instanceHydrawise ?? '';
                break;
            default:
                effectiveInstance = payload.instance;
                break;
        }

        const setProgress = (message: string): void => {
            if (this.scanProgressClearTimer) {
                this.clearTimeout(this.scanProgressClearTimer);
                this.scanProgressClearTimer = undefined;
            }
            this.setState('scan.progress', { val: message, ack: true }).catch(() => {
                /* best-effort progress display */
            });
        };

        const finishProgress = (message: string): void => {
            setProgress(message);
            // Keep the progress display visible for a short grace period after the
            // scan finishes (see admin/jsonConfig.json "scanProgress" hidden formula,
            // which hides the field once this state is empty again), then clear it.
            this.scanProgressClearTimer = this.setTimeout(() => {
                this.scanProgressClearTimer = undefined;
                this.setState('scan.progress', { val: '', ack: true }).catch(() => {
                    /* best-effort progress display */
                });
            }, 10_000);
        };

        setProgress(`Scanning ${payload.type}...`);

        // Bound the scan with a timeout so a hung foreign adapter/API can never
        // leave isScanning (and thus all future scans) stuck forever.
        const SCAN_TIMEOUT_MS = 60_000;
        let result: Awaited<ReturnType<typeof scanForValves>>;
        try {
            result = await Promise.race([
                scanForValves(this, payload.type, effectiveInstance, payload.locationId, setProgress),
                new Promise<never>((_resolve, reject) => {
                    this.setTimeout(
                        () => reject(new Error(`Valve scan timed out after ${SCAN_TIMEOUT_MS / 1000}s`)),
                        SCAN_TIMEOUT_MS,
                    );
                }),
            ]);
        } catch (error) {
            const message = (error as Error).message;
            this.log.error(`Valve scan (${payload.type}) failed: ${message}`);
            finishProgress(`Scan failed: ${message}`);
            if (obj.callback) {
                this.sendTo(
                    obj.from,
                    obj.command,
                    { error: 'scanFailed', result: 'scanErrors', errors: [message] },
                    obj.callback,
                );
            }
            return;
        }

        const scannedValvesByStateId = new Map(result.valves.map(valve => [valve.stateId, valve]));
        const existingStateIds = new Set(this.config2.valves.map(valve => valve.stateId));
        const newValves = result.valves.filter(valve => !existingStateIds.has(valve.stateId));
        let updatedNames = 0;
        // Newly scanned valves get freshly assigned, never-reused stable ids from
        // the nextValveId counter; existing valves keep their current id
        // unchanged so their real object id/state history survives the merge -
        // see the IValveConfig.id doc comment.
        let nextId = this.config2.nextValveId;
        const mergedValves = [...this.config2.valves, ...newValves.map(valve => ({ ...valve, id: nextId++ }))].map(
            (valve, index) => {
                const scannedValve = scannedValvesByStateId.get(valve.stateId);
                const name = scannedValve?.name || valve.name;
                if (index < this.config2.valves.length && name !== valve.name) {
                    updatedNames++;
                }
                return {
                    ...valve,
                    name,
                    valveNumber: `valve_${formatValveNumber(valve.id ?? index)}`,
                };
            },
        );

        this.log.info(
            `Valve scan (${payload.type}): found ${result.valves.length}, added ${newValves.length} new, updated ${updatedNames} name(s), ${result.errors.length} error(s)`,
        );

        if (newValves.length > 0 || updatedNames > 0) {
            await this.writeNativeAsync({
                valves: this.formatValvesForNative(mergedValves) as unknown as IValveConfig[],
                nextValveId: nextId,
            });
        }

        const doneMessage =
            result.errors.length > 0
                ? `Scan finished with errors: ${result.errors.join('; ')}`
                : newValves.length > 0
                  ? `Found and added ${newValves.length} new valve(s).`
                  : updatedNames > 0
                    ? `Updated ${updatedNames} valve name(s).`
                    : 'Scan finished, no new valves found.';
        finishProgress(doneMessage);

        if (obj.callback) {
            this.sendTo(
                obj.from,
                obj.command,
                {
                    found: result.valves.length,
                    new: newValves.length,
                    errors: result.errors,
                    // useNative (without saveConfig) merges the updated valves array into
                    // the currently open settings dialog's form state and forces a
                    // targeted re-render of the table, without triggering the "Save
                    // configuration?" dialog (that is only triggered by saveConfig: true,
                    // which we deliberately omit since persistence already happened above
                    // via writeValvesToNative/setForeignObjectAsync).
                    native: { valves: this.formatValvesForNative(mergedValves) },
                    result: result.errors.length > 0 ? 'scanErrors' : 'scanDone',
                    error: undefined,
                    args: [String(newValves.length), String(result.valves.length)],
                },
                obj.callback,
            );
        }
        return;
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Irrigation(options);
} else {
    (() => new Irrigation())();
}
