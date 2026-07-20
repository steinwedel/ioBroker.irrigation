/*
 * ioBroker Irrigation Adapter
 * See plans/irrigation-adapter-plan.md for the full design.
 */

import * as utils from '@iobroker/adapter-core';
import { normalizeConfig } from './lib/config-defaults';
import type { IrrigationNativeConfig, IValveConfig, ScanType } from './lib/types';
import { formatValveNumber, NONE_SENTINEL } from './lib/types';
import { createBaseStates, applyConfigToStates } from './lib/states';
import { ValveController } from './lib/ventile';
import { AutomationEngine } from './lib/automation';
import { Scheduler, resolvePlanFromIcalTitle } from './lib/scheduler';
import { SensorManager } from './lib/sensors';
import { DwdRestriction } from './lib/dwd';
import { WaterConsumptionTracker } from './lib/water-consumption';
import { WeatherApi } from './lib/weather-api';
import { NotificationManager } from './lib/notifications';
import { FlowMonitor } from './lib/flow-monitor';
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
 * Key-order-independent shallow equality check for two plain objects (e.g.
 * IValveConfig entries). Used instead of JSON.stringify comparison, since
 * JSON.stringify is sensitive to property insertion order and can report
 * two structurally identical objects as different, causing unnecessary
 * (and potentially repeated/looping) native config migrations.
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
class Irrigation extends utils.Adapter {
    private config2!: IrrigationNativeConfig;
    private valves: ValveController[] = [];
    private automation!: AutomationEngine;
    private scheduler!: Scheduler;
    private sensorManager!: SensorManager;
    private dwd!: DwdRestriction;
    private waterConsumption!: WaterConsumptionTracker;
    private weatherApi!: WeatherApi;
    private notifications!: NotificationManager;
    private flowMonitor!: FlowMonitor;
    private rateLimiter!: RateLimiter;
    private rateLimiterPoll: ReturnType<ioBroker.Adapter['setInterval']> | undefined;

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
        this.config2 = normalizeConfig(this.config);
        await this.migrateNativeConfig();
        await this.cleanupStaleValveObjects();
        await this.cleanupStaleZoneObjects();

        await createBaseStates(this);
        await applyConfigToStates(this, this.config2);

        this.rateLimiter = new RateLimiter();
        await this.createRateLimitStates();

        this.valves = this.config2.valves.map(
            (valveConfig, index) => new ValveController(this, index, valveConfig, this.rateLimiter),
        );
        for (const valve of this.valves) {
            await valve.init();
        }

        this.notifications = new NotificationManager({ adapter: this, getConfig: () => this.config2 });

        this.sensorManager = new SensorManager({ adapter: this, getConfig: () => this.config2 });
        await this.sensorManager.init();

        this.waterConsumption = new WaterConsumptionTracker({ adapter: this, getConfig: () => this.config2 });
        await this.waterConsumption.init();

        this.flowMonitor = new FlowMonitor({
            adapter: this,
            getConfig: () => this.config2,
            notifications: this.notifications,
            isAnyValveRunning: () => this.valves.some(v => v.isRunning()),
        });
        await this.flowMonitor.init();

        this.automation = new AutomationEngine({
            adapter: this,
            getConfig: () => this.config2,
            valves: this.valves,
            isValveBlockedForAutoRun: valveIndex => this.sensorManager.isValveBlocked(valveIndex),
            isLegallyRestricted: () => this.dwd.isActive(),
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

        // Subscribe to all our own automation/zone/valve control states
        this.subscribeStates('automation.*');
        this.subscribeStates('valves.*.manualStart');
        this.subscribeStates('watchdog.testNotify');
        this.subscribeStates('valves.*.state');
        this.subscribeStates('valves.*.runFor');

        await this.setStateAsync('info.connection', { val: true, ack: true });

        this.rateLimiterPoll = this.setInterval(() => this.updateRateLimitStates(), 10_000);
    }

    /**
     * Persists newly introduced/normalized config fields (e.g. IValveConfig.runFor)
     * plus a display-only "valveNumber" (e.g. "valve_2") back into `native` so the
     * admin config table shows real, editable/readable values for existing entries
     * instead of blanks. Only writes when something actually changed, since
     * updating our own instance's `native` triggers an adapter restart.
     */
    private async migrateNativeConfig(): Promise<void> {
        const rawValves = (this.config as unknown as { valves?: Record<string, unknown>[] }).valves ?? [];
        const migratedValves = this.config2.valves.map((valve, index) => ({
            ...valve,
            valveNumber: `valve_${formatValveNumber(index)}`,
        }));
        const needsValveMigration =
            rawValves.length !== migratedValves.length || rawValves.some(raw => !raw.valveNumber);

        if (needsValveMigration) {
            this.log.info('Migrating native.valves to include newly introduced fields (runFor, valveNumber).');
            await this.writeNativeAsync({ valves: migratedValves });
        }
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
                    this.config2.plans[0]?.name ?? 'Alle',
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

    private onUnload(callback: () => void): void {
        try {
            if (this.rateLimiterPoll) {
                this.clearInterval(this.rateLimiterPoll);
                this.rateLimiterPoll = undefined;
            }
            this.rateLimiter?.destroy();
            this.automation?.destroy();
            this.scheduler?.destroy();
            this.dwd?.destroy();
            this.weatherApi?.destroy();
            this.flowMonitor?.destroy();
            for (const valve of this.valves) {
                valve.destroy();
            }
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${(error as Error).message}`);
            callback();
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state) {
            return;
        }

        // Foreign state changes (valves, sensors, ical trigger, flow sensors)
        if (!id.startsWith(`${this.namespace}.`)) {
            for (const valve of this.valves) {
                if (await valve.onForeignStateChange(id, state)) {
                    return;
                }
            }
            if (await this.sensorManager.onForeignStateChange(id, state)) {
                return;
            }
            if (await this.scheduler.onForeignStateChange(id, state)) {
                return;
            }
            if (await this.flowMonitor.onForeignStateChange(id, state)) {
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
                await this.automation.requestRun(this.config2.plans[0]?.name ?? 'Alle', 'manual-button');
                return;
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
            const valveIndex = parseInt(valveManualStartMatch[1], 10);
            await this.automation.manualStartValve(valveIndex);
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
            instanceObj.native = { ...(instanceObj.native ?? {}), ...partialNative };
            await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instanceObj);
        }
    }

    private async writeValvesToNative(valves: IValveConfig[]): Promise<void> {
        await this.writeNativeAsync({ valves });
    }

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (typeof obj !== 'object' || !obj.command) {
            return;
        }

        if (obj.command === 'scanValves') {
            const payload = obj.message as {
                type: ScanType;
                instance: string;
                instanceRainbird?: string;
                instanceHomematic?: string;
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
                default:
                    effectiveInstance = payload.instance;
                    break;
            }

            const setProgress = (message: string): void => {
                this.setState('scan.progress', { val: message, ack: true }).catch(() => {
                    /* best-effort progress display */
                });
            };

            setProgress(`Scanning ${payload.type}...`);
            const result = await scanForValves(this, payload.type, effectiveInstance, payload.locationId, setProgress);

            const existingStateIds = new Set(this.config2.valves.map(v => v.stateId));
            const newValves = result.valves.filter(v => !existingStateIds.has(v.stateId));
            const mergedValves = [...this.config2.valves, ...newValves].map((valve, index) => ({
                ...valve,
                valveNumber: `valve_${formatValveNumber(index)}`,
            }));

            this.log.info(
                `Valve scan (${payload.type}): found ${result.valves.length}, added ${newValves.length} new, ${result.errors.length} error(s)`,
            );

            if (newValves.length > 0) {
                await this.writeValvesToNative(mergedValves);
            }

            const doneMessage =
                result.errors.length > 0
                    ? `Scan finished with errors: ${result.errors.join('; ')}`
                    : newValves.length > 0
                      ? `Found and added ${newValves.length} new valve(s).`
                      : 'Scan finished, no new valves found.';
            setProgress(doneMessage);

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
                        native: { valves: mergedValves },
                        result: result.errors.length > 0 ? 'scanErrors' : 'scanDone',
                        error: undefined,
                        args: [String(newValves.length), String(result.valves.length)],
                    },
                    obj.callback,
                );
            }
            return;
        }

        if (obj.command === 'deleteAllValves') {
            const count = this.config2.valves.length;
            this.log.info(`Deleting all ${count} valve(s) from configuration`);

            if (count > 0) {
                await this.writeValvesToNative([]);
            }

            if (obj.callback) {
                // See comment above: useNative without saveConfig refreshes the open
                // dialog's table live without popping up a save-configuration dialog.
                this.sendTo(obj.from, obj.command, { native: { valves: [] } }, obj.callback);
            }
            return;
        }

        if (obj.command === 'deleteValvesByStateId') {
            const stateIds = (obj.message as { stateIds?: string[] } | undefined)?.stateIds ?? [];
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

        if (obj.command === 'createPlan' && obj.callback) {
            const name = ((obj.message as Record<string, unknown>)?.newPlanName as string | undefined)?.trim();
            if (!name) {
                this.sendTo(obj.from, obj.command, { error: 'noName' }, obj.callback);
                return;
            }
            const updatedPlans = [...this.config2.plans, { name, valveIndexes: [] }];
            await this.writeNativeAsync({ plans: updatedPlans });
            const newIndex = updatedPlans.length - 1;
            this.log.info(`Created new plan "${name}"`);
            this.sendTo(
                obj.from,
                obj.command,
                { native: { plans: updatedPlans, _editPlan: newIndex, newPlanName: '' } },
                obj.callback,
            );
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
            await this.writeNativeAsync({ plans: updatedPlans });
            this.log.info(`Deleted plan "${removedName}"`);
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans, _editPlan: 0 } }, obj.callback);
            return;
        }

        if (obj.command === 'listPlanValves' && obj.callback) {
            const planIndex = readPlanIndex(obj.message);
            const planValveIndexes =
                planIndex !== undefined && planIndex >= 0 && planIndex < this.config2.plans.length
                    ? this.config2.plans[planIndex].valveIndexes
                    : [];
            const options = planValveIndexes
                .filter(i => i !== NONE_SENTINEL)
                .map(i => ({
                    label: `[${formatValveNumber(i)}] ${this.config2.valves[i]?.name || 'unnamed'}`,
                    value: i,
                }));
            this.sendTo(obj.from, obj.command, options, obj.callback);
            return;
        }

        if (obj.command === 'listAvailableValves' && obj.callback) {
            const planIndex = readPlanIndex(obj.message);
            const planValveIndexes =
                planIndex !== undefined && planIndex >= 0 && planIndex < this.config2.plans.length
                    ? new Set(this.config2.plans[planIndex].valveIndexes)
                    : new Set<number>();
            const options = this.config2.valves
                .map((v, i) => ({ label: `[${formatValveNumber(i)}] ${v.name || 'unnamed'}`, value: i }))
                .filter(opt => !planValveIndexes.has(opt.value));
            this.sendTo(obj.from, obj.command, options, obj.callback);
            return;
        }

        if (obj.command === 'assignValvesToPlan' && obj.callback) {
            const msg = obj.message as Record<string, unknown>;
            const planIndex = readPlanIndex(msg);
            const selected = (msg?.availableValves as number[] | undefined) ?? [];
            if (planIndex === undefined || planIndex < 0 || planIndex >= this.config2.plans.length) {
                return;
            }
            const updatedPlans = this.config2.plans.map((p, i) => {
                if (i !== planIndex) {
                    return p;
                }
                const merged = new Set([...p.valveIndexes, ...selected]);
                merged.delete(NONE_SENTINEL);
                return { ...p, valveIndexes: [...merged].sort((a, b) => a - b) };
            });
            await this.writeNativeAsync({ plans: updatedPlans });
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
            return;
        }

        if (obj.command === 'removeValvesFromPlan' && obj.callback) {
            const msg = obj.message as Record<string, unknown>;
            const planIndex = readPlanIndex(msg);
            const selected = new Set((msg?.planValvesRefresh as number[] | undefined) ?? []);
            if (planIndex === undefined || planIndex < 0 || planIndex >= this.config2.plans.length) {
                return;
            }
            const updatedPlans = this.config2.plans.map((p, i) => {
                if (i !== planIndex) {
                    return p;
                }
                // An empty valveIndexes array means "all valves" (see buildActiveValveList()),
                // so falling through to [] here after removing the last real valve would
                // silently re-include every valve instead of leaving the plan empty.
                const remaining = p.valveIndexes.filter(vi => !selected.has(vi));
                return { ...p, valveIndexes: remaining.length > 0 ? remaining : [NONE_SENTINEL] };
            });
            await this.writeNativeAsync({ plans: updatedPlans });
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
            return;
        }

        if (obj.command === 'addAllValvesToPlan' && obj.callback) {
            const planIndex = readPlanIndex(obj.message);
            if (planIndex === undefined || planIndex < 0 || planIndex >= this.config2.plans.length) {
                return;
            }
            const allValveIndexes = this.config2.valves.map((_, i) => i);
            const updatedPlans = this.config2.plans.map((p, i) =>
                i === planIndex ? { ...p, valveIndexes: [...allValveIndexes] } : p,
            );
            await this.writeNativeAsync({ plans: updatedPlans });
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
            return;
        }

        if (obj.command === 'removeAllValvesFromPlan' && obj.callback) {
            const planIndex = readPlanIndex(obj.message);
            if (planIndex === undefined || planIndex < 0 || planIndex >= this.config2.plans.length) {
                return;
            }
            const updatedPlans = this.config2.plans.map((p, i) =>
                i === planIndex ? { ...p, valveIndexes: [NONE_SENTINEL] } : p,
            );
            await this.writeNativeAsync({ plans: updatedPlans });
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
            return;
        }

        if (obj.command === 'addAllValvesToAllPlans' && obj.callback) {
            const allValveIndexes = this.config2.valves.map((_, i) => i);
            const updatedPlans = this.config2.plans.map(p => ({
                ...p,
                valveIndexes: [...allValveIndexes],
            }));
            await this.writeNativeAsync({ plans: updatedPlans });
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
            return;
        }

        if (obj.command === 'removeAllValvesFromAllPlans' && obj.callback) {
            const updatedPlans = this.config2.plans.map(p => ({ ...p, valveIndexes: [NONE_SENTINEL] }));
            await this.writeNativeAsync({ plans: updatedPlans });
            this.sendTo(obj.from, obj.command, { native: { plans: updatedPlans } }, obj.callback);
            return;
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Irrigation(options);
} else {
    (() => new Irrigation())();
}
