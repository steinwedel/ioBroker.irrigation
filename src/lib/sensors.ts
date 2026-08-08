import type { IrrigationNativeConfig } from './types';
import { evaluateHysteresisPause, hysteresisMinutesToMs, type HysteresisPauseState } from './hysteresis';

/** Sensor values older than this are considered stale and trigger conservative blocking. */
const MAX_SENSOR_AGE_MS = 2 * 60 * 60 * 1000;

/** How often evaluateRainPause() is re-run even without a new rain-sensor event, so the hysteresis delay elapses reliably while rain stays off. Mirrors WindMonitor's periodic check. */
const RAIN_CHECK_INTERVAL_MS = 30_000;

/** @deprecated Use HysteresisPauseState from './hysteresis' instead; kept as an alias for existing imports/tests. */
export type RainPauseState = HysteresisPauseState;

/**
 * Pure decision function for the rain pause-with-hysteresis logic. Many rain
 * sensors (e.g. tipping-bucket gauges) toggle their boolean "rain detected"
 * state true/false in quick succession as individual drops register; without
 * this hysteresis, every such flip would immediately stop and then restart
 * every currently running valve via AutomationEngine.setRainPause(),
 * producing a sustained stream of real start()/stop() hardware commands with
 * no obvious external trigger. Once rain is detected, the pause is
 * immediate; once rain stops, it only resumes after staying clear
 * continuously for `hysteresisMs`. Delegates the actual hysteresis timing to
 * the shared evaluateHysteresisPause() (see hysteresis.ts), which
 * WindMonitor's evaluate() (wind.ts) also uses, so both stay behaviorally
 * consistent.
 *
 * @param params
 * @param params.raining Current raw rain-sensor reading.
 * @param params.belowSinceMs Previous `belowSinceMs` from the last evaluation (state carried between calls).
 * @param params.nowMs Current timestamp in ms.
 * @param params.hysteresisMs Minimum time in ms that rain must stay off before resuming.
 */
export function evaluateRainPause(params: {
    raining: boolean;
    belowSinceMs: number | null;
    nowMs: number;
    hysteresisMs: number;
}): RainPauseState {
    const { raining, belowSinceMs, nowMs, hysteresisMs } = params;
    return evaluateHysteresisPause({ overLimit: raining, belowSinceMs, nowMs, hysteresisMs });
}

export interface SensorsDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    onRainChange?: (raining: boolean) => Promise<void>;
}

/**
 * Subscribes to configured rain/soil-moisture/temperature sensor state ids
 * and mirrors their values into sensors.* states. Also exposes the
 * valve-blocking predicate used by automation.ts's buildActiveZoneList().
 */
export class SensorManager {
    private readonly deps: SensorsDeps;
    private rainState = false;
    private soilMoistureState = 0;
    private temperatureState = 0;
    private rainStateTs: number | undefined;
    private soilMoistureTs: number | undefined;
    private readonly soilMoistureValues = new Map<string, { value: number; ts: number }>();
    private temperatureTs: number | undefined;
    private subscribedIds: string[] = [];
    /** Debounced/hysteresis-applied pause decision last reported via onRainChange(), see evaluateRainPause(). */
    private rainPaused = false;
    private rainBelowSinceMs: number | null = null;
    /** Periodic re-evaluation so the resume hysteresis elapses even without a new rain-sensor event. */
    private rainCheckTimer: ReturnType<ioBroker.Adapter['setInterval']> | undefined;

    public constructor(deps: SensorsDeps) {
        this.deps = deps;
    }

    public async init(): Promise<void> {
        await this.resubscribe();
        this.rainCheckTimer = this.deps.adapter.setInterval(() => {
            this.evaluateRainPause().catch(error =>
                this.deps.adapter.log.error(`Rain pause check failed: ${(error as Error).message}`),
            );
        }, RAIN_CHECK_INTERVAL_MS);
        await this.evaluateRainPause();
    }

    public async resubscribe(): Promise<void> {
        for (const id of this.subscribedIds) {
            await this.deps.adapter.unsubscribeForeignStatesAsync(id);
        }
        this.subscribedIds = [];

        const config = this.deps.getConfig();
        const soilMoistureIds = new Set(
            [config.sensors.soilMoistureId, ...config.valves.map(valve => valve.soilMoistureId ?? '')].filter(Boolean),
        );
        const stateIds = new Set([
            config.sensors.rainId,
            ...soilMoistureIds,
            config.sensors.temperatureId,
            config.legalRestriction.temperatureStateId,
        ]);
        for (const id of stateIds) {
            if (id) {
                await this.deps.adapter.subscribeForeignStatesAsync(id);
                this.subscribedIds.push(id);
            }
        }

        // Read the current value of each subscribed state immediately so
        // rain/soilMoisture/temperature reflect reality right after (re)start,
        // instead of staying at their fail-open defaults (e.g. rainState=false)
        // until the next foreign-state push from the sensor.
        if (config.sensors.rainId) {
            const state = await this.deps.adapter.getForeignStateAsync(config.sensors.rainId);
            if (typeof state?.val === 'boolean') {
                this.rainState = state.val;
                this.rainStateTs = typeof state.ts === 'number' ? state.ts : Date.now();
                await this.deps.adapter.setStateAsync('sensors.rain', { val: this.rainState, ack: true });
            }
        }
        this.soilMoistureValues.clear();
        for (const id of soilMoistureIds) {
            const state = await this.deps.adapter.getForeignStateAsync(id);
            if (typeof state?.val !== 'number' || !Number.isFinite(state.val)) {
                continue;
            }
            const ts = typeof state.ts === 'number' ? state.ts : Date.now();
            this.soilMoistureValues.set(id, { value: state.val, ts });
            if (id === config.sensors.soilMoistureId) {
                this.soilMoistureState = state.val;
                this.soilMoistureTs = ts;
                await this.deps.adapter.setStateAsync('sensors.soilMoisture', {
                    val: this.soilMoistureState,
                    ack: true,
                });
            }
        }
        if (config.sensors.temperatureId) {
            const state = await this.deps.adapter.getForeignStateAsync(config.sensors.temperatureId);
            if (typeof state?.val === 'number' && Number.isFinite(state.val)) {
                this.temperatureState = state.val;
                this.temperatureTs = typeof state.ts === 'number' ? state.ts : Date.now();
                await this.deps.adapter.setStateAsync('sensors.temperature', {
                    val: this.temperatureState,
                    ack: true,
                });
            }
        }
    }

    public async onForeignStateChange(id: string, state: ioBroker.State | null | undefined): Promise<boolean> {
        const config = this.deps.getConfig();
        if (id === config.sensors.rainId) {
            if (typeof state?.val === 'boolean') {
                this.rainState = state.val;
            } else {
                this.deps.adapter.log.warn(
                    `Rain sensor state ${id} has no valid boolean value; keeping previous value (${this.rainState}).`,
                );
            }
            this.rainStateTs = Date.now();
            await this.deps.adapter.setStateAsync('sensors.rain', { val: this.rainState, ack: true });
            // Debounced through evaluateRainPause() rather than calling onRainChange()
            // directly here - see the evaluateRainPause()/RainPauseState doc comment
            // for why an un-debounced pause signal can repeatedly stop and restart
            // every currently running valve for a flapping (e.g. tipping-bucket) rain
            // sensor.
            await this.evaluateRainPause();
            return true;
        }
        const isGlobalSoilMoistureSensor = id === config.sensors.soilMoistureId;
        const isValveSoilMoistureSensor = config.valves.some(valve => valve.soilMoistureId === id);
        if (isGlobalSoilMoistureSensor || isValveSoilMoistureSensor) {
            if (typeof state?.val !== 'number' || !Number.isFinite(state.val)) {
                this.deps.adapter.log.warn(
                    `Soil moisture sensor state ${id} has no valid numeric value; keeping previous value.`,
                );
                return true;
            }
            const ts = typeof state.ts === 'number' ? state.ts : Date.now();
            this.soilMoistureValues.set(id, { value: state.val, ts });
            if (isGlobalSoilMoistureSensor) {
                this.soilMoistureState = state.val;
                this.soilMoistureTs = ts;
                await this.deps.adapter.setStateAsync('sensors.soilMoisture', {
                    val: this.soilMoistureState,
                    ack: true,
                });
            }
            return true;
        }
        if (id === config.sensors.temperatureId) {
            if (typeof state?.val === 'number' && Number.isFinite(state.val)) {
                this.temperatureState = state.val;
            } else {
                this.deps.adapter.log.warn(
                    `Temperature sensor state ${id} has no valid numeric value; keeping previous value (${this.temperatureState}).`,
                );
            }
            this.temperatureTs = Date.now();
            await this.deps.adapter.setStateAsync('sensors.temperature', { val: this.temperatureState, ack: true });
            return true;
        }
        return false;
    }

    public isRaining(): boolean {
        return this.rainState;
    }

    public getSoilMoisture(): number {
        return this.soilMoistureState;
    }

    public getTemperature(): number {
        return this.temperatureState;
    }

    private isStale(ts: number | undefined): boolean {
        return ts === undefined || Date.now() - ts > MAX_SENSOR_AGE_MS;
    }

    public async getTemperatureAdjustmentTemperature(): Promise<number | undefined> {
        const stateId = this.deps.getConfig().scheduler.temperatureAdjustmentStateId;
        if (!stateId) {
            return undefined;
        }
        const state = await this.deps.adapter.getForeignStateAsync(stateId);
        return typeof state?.val === 'number' && Number.isFinite(state.val) ? state.val : undefined;
    }

    /**
     * Called on adapter unload to release the foreign-state subscriptions made
     * in resubscribe()/init(), for consistency with the other subsystems'
     * cleanup discipline (rateLimiter, automation, scheduler, dwd, windMonitor,
     * weatherApi, flowMonitor, valves).
     */
    public destroy(): void {
        if (this.rainCheckTimer) {
            this.deps.adapter.clearInterval(this.rainCheckTimer);
            this.rainCheckTimer = undefined;
        }
        for (const id of this.subscribedIds) {
            this.deps.adapter.unsubscribeForeignStatesAsync(id).catch(() => undefined);
        }
        this.subscribedIds = [];
    }

    /**
     * Applies evaluateRainPause() to the current raw `rainState` and only
     * calls onRainChange() when the debounced decision actually flips - see
     * the evaluateRainPause()/RainPauseState doc comment for why this
     * debouncing is necessary. Run both on every rain-sensor event and
     * periodically (see RAIN_CHECK_INTERVAL_MS) so the hysteresis delay
     * elapses reliably even while no new sensor event arrives.
     */
    private async evaluateRainPause(): Promise<void> {
        const hysteresisMinutes = this.deps.getConfig().scheduler.rainHysteresisMinutes;
        const result = evaluateRainPause({
            raining: this.rainState,
            belowSinceMs: this.rainBelowSinceMs,
            nowMs: Date.now(),
            hysteresisMs: hysteresisMinutesToMs(hysteresisMinutes),
        });
        this.rainBelowSinceMs = result.belowSinceMs;
        if (result.paused !== this.rainPaused) {
            this.rainPaused = result.paused;
            await this.deps.onRainChange?.(this.rainPaused);
        }
    }

    /**
     * See plan behavior rules "Niederschlagsunabhängigkeit" and "Bodenfeuchte-Schwellwert".
     *
     * @param valveIndex
     */
    public isValveBlocked(valveIndex: number): { blocked: boolean; reason?: string } {
        const config = this.deps.getConfig();
        const valve = config.valves[valveIndex];
        if (!valve) {
            return { blocked: false };
        }

        if (config.sensors.rainId && this.rainState && !valve.rainIndependent) {
            return { blocked: true, reason: 'rain detected' };
        }
        if (config.sensors.rainId && !valve.rainIndependent && this.isStale(this.rainStateTs)) {
            this.deps.adapter.log.warn(
                `Rain sensor value is stale (older than ${MAX_SENSOR_AGE_MS / 60_000} minutes); blocking valve as a precaution.`,
            );
            return { blocked: true, reason: 'rain sensor data is stale' };
        }
        const soilMoisture = valve.soilMoistureId ? this.soilMoistureValues.get(valve.soilMoistureId) : undefined;
        if (soilMoisture && valve.moistureThreshold > 0 && soilMoisture.value >= valve.moistureThreshold) {
            return {
                blocked: true,
                reason: `soil moisture ${soilMoisture.value}% >= threshold ${valve.moistureThreshold}%`,
            };
        }
        return { blocked: false };
    }

    /** See plan behavior rule "Frostschutz". */
    public isFrostBlocked(): boolean {
        const config = this.deps.getConfig();
        if (!config.scheduler.frostEnabled) {
            return false;
        }
        const temp = config.sensors.temperatureId ? this.temperatureState : undefined;
        if (temp === undefined) {
            return false;
        }
        if (config.sensors.temperatureId && this.isStale(this.temperatureTs)) {
            this.deps.adapter.log.warn(
                `Temperature sensor value is stale (older than ${MAX_SENSOR_AGE_MS / 60_000} minutes); assuming frost protection is active as a precaution.`,
            );
            return true;
        }
        return temp < config.scheduler.frostMinTemp;
    }

    /** See plan behavior rule "Saison-Pause". */
    public isSeasonBlocked(): boolean {
        const config = this.deps.getConfig();
        if (!config.scheduler.seasonEnabled) {
            return false;
        }
        const month = new Date().getMonth() + 1;
        const { seasonStart, seasonEnd } = config.scheduler;
        if (seasonStart <= seasonEnd) {
            return month < seasonStart || month > seasonEnd;
        }
        // wraps around the year (e.g. start=11, end=2)
        return month < seasonStart && month > seasonEnd;
    }
}
