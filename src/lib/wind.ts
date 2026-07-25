import type { IrrigationNativeConfig } from './types';

export interface WindDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    onWindPauseChange: (paused: boolean) => Promise<void>;
}

export interface WindPauseState {
    /** True while speed or gust is at/above its configured limit, or hysteresis has not elapsed yet */
    paused: boolean;
    /** Timestamp (ms) since speed/gust first dropped below both limits, or null while over limit */
    belowSinceMs: number | null;
}

/**
 * Pure decision function for the wind/gust pause-with-hysteresis logic (see
 * plan section "Windgrenze"/"Böen"/"Wind-Hysterese"). A limit of 0 disables
 * that particular check. Once over a limit, the valve stays paused
 * immediately; once both are back under their limits, it only resumes after
 * staying there continuously for `hysteresisMs`, avoiding rapid pause/resume
 * flapping in gusty conditions.
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

    if (overLimit) {
        return { paused: true, belowSinceMs: null };
    }

    const effectiveBelowSinceMs = belowSinceMs ?? nowMs;
    const elapsedMs = nowMs - effectiveBelowSinceMs;
    return { paused: elapsedMs < hysteresisMs, belowSinceMs: effectiveBelowSinceMs };
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
        const config = this.deps.getConfig().scheduler;
        for (const id of new Set([config.windSpeedStateId, config.windGustStateId])) {
            if (id) {
                await this.deps.adapter.subscribeForeignStatesAsync(id);
                this.subscribedIds.push(id);
            }
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
            hysteresisMs: Math.max(0, config.windHysteresisMinutes) * 60_000,
        });
        this.belowSinceMs = result.belowSinceMs;
        if (result.paused !== this.paused) {
            this.paused = result.paused;
            await this.deps.onWindPauseChange(this.paused);
        }
    }
}
