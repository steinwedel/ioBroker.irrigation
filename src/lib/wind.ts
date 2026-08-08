import type { IrrigationNativeConfig } from './types';
import { evaluateHysteresisPause, hysteresisMinutesToMs, type HysteresisPauseState } from './hysteresis';

export interface WindDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    onWindPauseChange: (paused: boolean) => Promise<void>;
}

/** @deprecated Use HysteresisPauseState from './hysteresis' instead; kept as an alias for existing imports/tests. */
export type WindPauseState = HysteresisPauseState;

/**
 * Pure decision function for the wind/gust pause-with-hysteresis logic (see
 * plan section "Windgrenze"/"Böen"/"Wind-Hysterese"). A limit of 0 disables
 * that particular check. Once over a limit, the valve stays paused
 * immediately; once both are back under their limits, it only resumes after
 * staying there continuously for `hysteresisMs`, avoiding rapid pause/resume
 * flapping in gusty conditions. Delegates the actual hysteresis timing to the
 * shared evaluateHysteresisPause() (see hysteresis.ts), which SensorManager's
 * rain pause (sensors.ts) also uses, so both stay behaviorally consistent.
 *
 * @param params
 * @param params.speed Current wind speed in km/h, or undefined if not configured/available.
 * @param params.gust Current wind gust in km/h, or undefined if not configured/available.
 * @param params.speedLimit Speed limit in km/h; 0 disables the speed check.
 * @param params.gustLimit Gust limit in km/h; 0 disables the gust check.
 * @param params.belowSinceMs Previous `belowSinceMs` from the last evaluation (state carried between calls).
 * @param params.nowMs Current timestamp in ms.
 * @param params.hysteresisMs Minimum time in ms that speed/gust must stay below both limits before resuming.
 */
export function evaluateWindPause(params: {
    speed: number | undefined;
    gust: number | undefined;
    speedLimit: number;
    gustLimit: number;
    belowSinceMs: number | null;
    nowMs: number;
    hysteresisMs: number;
}): WindPauseState {
    const { speed, gust, speedLimit, gustLimit, belowSinceMs, nowMs, hysteresisMs } = params;
    const overLimit =
        (speedLimit > 0 && speed !== undefined && speed >= speedLimit) ||
        (gustLimit > 0 && gust !== undefined && gust >= gustLimit);
    return evaluateHysteresisPause({ overLimit, belowSinceMs, nowMs, hysteresisMs });
}

/**
 * Monitors configured wind-speed/gust states and pauses/resumes automatic
 * watering via AutomationEngine.setWindPause(), applying a resume hysteresis
 * so brief dips below the limit do not immediately restart watering. Uses a
 * periodic check (rather than only reacting to state changes) so the
 * hysteresis period is also evaluated while wind stays calm and no new
 * foreign-state events arrive.
 */
export class WindMonitor {
    private readonly deps: WindDeps;
    private speed: number | undefined;
    private gust: number | undefined;
    private belowSinceMs: number | null = null;
    private paused = false;
    private checkTimer: ReturnType<ioBroker.Adapter['setInterval']> | undefined;
    private subscribedIds: string[] = [];

    public constructor(deps: WindDeps) {
        this.deps = deps;
    }

    public isOverLimit(): boolean {
        return this.paused;
    }

    public async init(): Promise<void> {
        await this.resubscribe();
        this.checkTimer = this.deps.adapter.setInterval(() => {
            this.evaluate().catch(error =>
                this.deps.adapter.log.error(`Wind pause check failed: ${(error as Error).message}`),
            );
        }, 30_000);
        await this.evaluate();
    }

    public destroy(): void {
        if (this.checkTimer) {
            this.deps.adapter.clearInterval(this.checkTimer);
            this.checkTimer = undefined;
        }
    }

    public async resubscribe(): Promise<void> {
        for (const id of this.subscribedIds) {
            await this.deps.adapter.unsubscribeForeignStatesAsync(id);
        }
        this.subscribedIds = [];
        this.speed = undefined;
        this.gust = undefined;
        const config = this.deps.getConfig().scheduler;
        for (const id of new Set([config.windSpeedStateId, config.windGustStateId])) {
            if (id) {
                await this.deps.adapter.subscribeForeignStatesAsync(id);
                this.subscribedIds.push(id);
            }
        }

        // Load the current value of each newly (re)subscribed state so speed/gust
        // reflect reality immediately after a (re)start, instead of staying at
        // their default/undefined values until the next foreign-state push.
        if (config.windSpeedStateId) {
            const state = await this.deps.adapter.getForeignStateAsync(config.windSpeedStateId);
            this.speed = typeof state?.val === 'number' && Number.isFinite(state.val) ? state.val : undefined;
        }
        if (config.windGustStateId) {
            const state = await this.deps.adapter.getForeignStateAsync(config.windGustStateId);
            this.gust = typeof state?.val === 'number' && Number.isFinite(state.val) ? state.val : undefined;
        }
    }

    public async onForeignStateChange(id: string, state: ioBroker.State | null | undefined): Promise<boolean> {
        const config = this.deps.getConfig().scheduler;
        if (id === config.windSpeedStateId) {
            this.speed = typeof state?.val === 'number' && Number.isFinite(state.val) ? state.val : undefined;
        } else if (id === config.windGustStateId) {
            this.gust = typeof state?.val === 'number' && Number.isFinite(state.val) ? state.val : undefined;
        } else {
            return false;
        }
        await this.evaluate();
        return true;
    }

    private async evaluate(): Promise<void> {
        const config = this.deps.getConfig().scheduler;
        if (!config.windPauseEnabled) {
            return;
        }
        const result = evaluateWindPause({
            speed: this.speed,
            gust: this.gust,
            speedLimit: config.windSpeedLimit,
            gustLimit: config.windGustLimit,
            belowSinceMs: this.belowSinceMs,
            nowMs: Date.now(),
            hysteresisMs: hysteresisMinutesToMs(config.windHysteresisMinutes),
        });
        this.belowSinceMs = result.belowSinceMs;
        if (result.paused !== this.paused) {
            this.paused = result.paused;
            await this.deps.onWindPauseChange(this.paused);
        }
    }
}
