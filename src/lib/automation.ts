import type { IrrigationNativeConfig, IValveConfig, IPlanConfig, AutomationStatus, PauseReason, Batch } from './types';
import type { ValveController } from './ventile';
import { rainbirdInstanceOf } from './ventile';
import { formatDuration } from './duration';

export function calculateTemperatureAdjustmentFactor(temperature: number): number {
    return 1.07 ** (temperature - 20);
}

export interface AutomationDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    valves: ValveController[];
    /** Returns true if the valve should be skipped for automatic runs right now (sensors, weekday, ...) */
    isValveBlockedForAutoRun: (valveIndex: number) => {
        blocked: boolean;
        reason?: string;
    };
    /** True if a legal restriction currently blocks watering */
    isLegallyRestricted: () => boolean;
    isRaining: () => boolean;
    isWindOverLimit: () => boolean;
    /** Called whenever water starts/stops flowing through a valve, for consumption tracking */
    onValveFlowChange?: (valveIndex: number, flowing: boolean) => void;
    /** Returns true if any valve is currently running */
    isAnyValveRunning?: () => boolean;
    getTemperatureAdjustmentTemperature: () => Promise<number | undefined>;
}

/**
 * Builds parallel batches of valve indexes from a flat list, respecting the
 * pump capacity constraint. See plan section
 * "Pumpenkapazität & Parallele Optimierung".
 *
 * Greedy bin-packing: valves sorted by duration descending; each valve is
 * placed into the existing batch whose total duration would grow the least
 * while staying within pumpCapacity, otherwise a new batch is created.
 *
 * Rainbird valves are additionally constrained to never share a batch with
 * another Rainbird valve of the *same* controller instance, regardless of
 * pumpCapacity: a Rainbird controller can only physically open one station
 * at a time, and ValveController.stop() commands the whole controller via
 * the shared `allOffId` ("stopIrrigation"), not a single zone - see
 * otherSiblingRainbirdValveRunning() in ventile.ts. Running two zones of the
 * same controller "in parallel" would therefore either not actually open
 * both stations, or have the first zone's stop() cut off the second zone's
 * still-running station. Rainbird valves on *different* controller
 * instances, and non-Rainbird valves, are unaffected and can still be
 * batched together normally.
 *
 * @param valveIndexes
 * @param valves
 * @param pumpCapacity
 */
export function buildBatches(valveIndexes: number[], valves: IValveConfig[], pumpCapacity: number): Batch[] {
    if (pumpCapacity <= 0) {
        // Sequential mode: one valve per batch, preserve original order
        return valveIndexes.map(idx => [idx]);
    }

    const sorted = [...valveIndexes].sort((a, b) => valves[b].duration - valves[a].duration);

    interface WorkingBatch {
        valveIdxs: number[];
        flowSum: number;
        duration: number;
        /** Rainbird controller instances (e.g. "rainbird.0") already occupied in this batch */
        rainbirdInstances: Set<string>;
    }
    const batches: WorkingBatch[] = [];

    for (const valveIdx of sorted) {
        const valve = valves[valveIdx];
        const flowRate = valve.flowRateLpm || 0;
        const rainbirdInstance = valve.type === 'Rainbird' ? rainbirdInstanceOf(valve.stateId) : undefined;

        let bestBatch: WorkingBatch | undefined;
        let bestIncrease = Infinity;

        for (const batch of batches) {
            if (batch.flowSum + flowRate > pumpCapacity) {
                continue;
            }
            if (rainbirdInstance && batch.rainbirdInstances.has(rainbirdInstance)) {
                continue;
            }
            const increase = Math.max(0, valve.duration - batch.duration);
            if (increase < bestIncrease) {
                bestIncrease = increase;
                bestBatch = batch;
            }
        }

        if (bestBatch) {
            bestBatch.valveIdxs.push(valveIdx);
            bestBatch.flowSum += flowRate;
            bestBatch.duration = Math.max(bestBatch.duration, valve.duration);
            if (rainbirdInstance) {
                bestBatch.rainbirdInstances.add(rainbirdInstance);
            }
        } else {
            batches.push({
                valveIdxs: [valveIdx],
                flowSum: flowRate,
                duration: valve.duration,
                rainbirdInstances: rainbirdInstance ? new Set([rainbirdInstance]) : new Set(),
            });
        }
    }

    return batches.map(b => b.valveIdxs);
}

export class AutomationEngine {
    private readonly deps: AutomationDeps;

    private status: AutomationStatus = 'idle';
    private pauseReason: PauseReason = null;
    /**
     * Internal, independently tracked blocker flags. Unlike the single
     * `pauseReason` enum (still maintained above for status-text
     * compatibility), these can all be active at the same time - e.g. a
     * legal restriction and rain can both be in effect simultaneously. Every
     * resume path (pause(), setRainPause(), setWindPause(),
     * finishManualRun(), onLegalRestrictionChanged()) must re-check all four
     * flags/conditions before actually resuming, so ending one blocker never
     * resumes watering while another is still active.
     */
    private blockedByRain = false;
    private blockedByWind = false;
    private blockedByLegalRestriction = false;
    private blockedManually = false;
    private activePlanName: string | null = null;
    private batches: Batch[] = [];
    private currentBatchIndex = -1;
    private runningValves = new Set<number>();
    private valveEndsAt = new Map<number, number>();
    private valveDurationSecs = new Map<number, number>();
    private inBatchPause = false;
    private batchPauseEndsAt = 0;
    private totalDurationMin = 0;
    private startedAtMs = 0;
    private valvePauseMs = 0;
    private temperatureAdjustmentFactor = 1;

    private manualRun: {
        valveIndex: number;
        endsAt: number;
    } | null = null;
    private wasAutomationPausedForManual = false;
    /** Last remaining-minutes value shown in automation.status during a manual run, used to throttle publishStatus() to only fire when the displayed value actually changes. */
    private lastManualRunRemainingMin = -1;

    private tickTimer: ReturnType<ioBroker.Adapter['setInterval']> | undefined;

    public constructor(deps: AutomationDeps) {
        this.deps = deps;
    }

    public getStatus(): AutomationStatus {
        return this.status;
    }

    public isManualRunActive(): boolean {
        return this.manualRun !== null;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    public start(): void {
        this.tickTimer = this.deps.adapter.setInterval(() => {
            this.tick().catch(error =>
                this.deps.adapter.log.error(`Automation tick failed: ${(error as Error).message}`),
            );
        }, 1000);
    }

    public destroy(): void {
        if (this.tickTimer) {
            this.deps.adapter.clearInterval(this.tickTimer);
            this.tickTimer = undefined;
        }
    }

    /**
     * Called once at adapter start. Previously this unconditionally called
     * stop() on every configured valve on every single restart - including
     * normal/frequent restarts (config changes, host reloads, etc.) - which
     * meant a Gardena valve started moments earlier from the Gardena app or
     * from ioBroker was immediately closed again by the very next restart,
     * regardless of who/what started it and regardless of whether an
     * automation run was actually interrupted.
     * Unconditionally stops every configured valve so the adapter always starts
     * from a known, consistent "all off" state - regardless of whether an
     * automation run was actually in progress, and regardless of whether a
     * valve is currently being controlled independently (e.g. from the
     * Gardena app or another ioBroker adapter). This intentionally trades
     * away the previous "only touch valves that were genuinely part of an
     * interrupted run" behavior in favor of a guaranteed consistent state on
     * every adapter start/restart.
     */
    public async recoverAfterRestart(): Promise<void> {
        for (const valve of this.deps.valves) {
            await valve.stop();
        }
        this.status = 'idle';
        this.clearAllBlockers();
        this.activePlanName = null;
        this.batches = [];
        this.currentBatchIndex = -1;
        this.runningValves.clear();
        this.manualRun = null;
        await this.publishStatus();
    }

    /**
     * Clears all independently tracked blocker flags. Used when a run
     * finishes/is reset entirely (recoverAfterRestart, finishRun) so no
     * stale blocker from a previous run can affect the next one.
     */
    private clearAllBlockers(): void {
        this.blockedByRain = false;
        this.blockedByWind = false;
        this.blockedByLegalRestriction = false;
        this.blockedManually = false;
        this.pauseReason = null;
    }

    /**
     * The single most relevant blocker for status-text display purposes,
     * derived from the independently tracked flags. Priority order:
     * legal restriction, then rain, then wind, then manual - matches the
     * previous single-`pauseReason` behavior's display priority as closely
     * as possible while allowing multiple blockers to be tracked
     * internally at once.
     */
    private computeDisplayPauseReason(): PauseReason {
        if (this.blockedByLegalRestriction) {
            return 'legalRestriction';
        }
        if (this.blockedByRain) {
            return 'rain';
        }
        if (this.blockedByWind) {
            return 'wind';
        }
        if (this.blockedManually) {
            return 'manual';
        }
        return null;
    }

    /** True if any blocker is currently active. */
    private hasActiveBlocker(): boolean {
        return this.blockedByRain || this.blockedByWind || this.blockedByLegalRestriction || this.blockedManually;
    }

    /**
     * Re-checks all four blocker conditions live (rain/wind/legal
     * restriction sensors plus the manual flag) and resumes the paused run
     * only if none of them are (still) active. Called from every
     * resume-triggering path (pause(), setRainPause(), setWindPause(),
     * onLegalRestrictionChanged(), finishManualRun()) after clearing the one
     * blocker that just ended, so overlapping blockers can never be papered
     * over by resuming while another one is still in effect.
     */
    private async tryResume(): Promise<void> {
        if (this.status !== 'paused' || this.manualRun) {
            return;
        }
        this.blockedByLegalRestriction = this.deps.isLegallyRestricted();
        this.blockedByRain = this.deps.getConfig().scheduler.pauseOnRain && this.deps.isRaining();
        this.blockedByWind = this.deps.getConfig().scheduler.windPauseEnabled && this.deps.isWindOverLimit();
        if (this.hasActiveBlocker()) {
            this.pauseReason = this.computeDisplayPauseReason();
            this.deps.adapter.log.warn(`Resume refused: still blocked (${this.pauseReason ?? 'unknown reason'}).`);
            await this.publishStatus();
            return;
        }
        this.pauseReason = null;
        this.status = 'running';
        if (this.currentBatchIndex === -1) {
            // was prepared but never started (see runPlan())
            await this.startNextBatch();
        } else {
            await this.resumeRunningValves();
            await this.publishStatus();
        }
    }

    // ------------------------------------------------------------------
    // Plan execution
    // ------------------------------------------------------------------

    /**
     * Entry point for automatic (timer/iCal) or manual "Start" triggers.
     * Applies the priority rules from the plan: ignored unless idle.
     *
     * @param planName
     * @param source
     */
    public async requestRun(planName: string, source: 'manual-button' | 'timer' | 'ical'): Promise<void> {
        if (this.manualRun) {
            this.deps.adapter.log.warn(`Run request (${source}) ignored: manual valve run in progress.`);
            return;
        }
        if (this.status !== 'idle') {
            this.deps.adapter.log.warn(`Run request (${source}) ignored: automation already ${this.status}.`);
            return;
        }
        await this.runPlan(planName);
    }

    private async runPlan(planName: string): Promise<void> {
        const config = this.deps.getConfig();
        const plan = config.plans.find(p => p.name === planName);
        if (!plan) {
            this.deps.adapter.log.error(
                `Unknown plan "${planName}", available: ${config.plans.map(p => p.name).join(', ')}`,
            );
            await this.deps.adapter.setStateAsync('automation.status', {
                val: `Mode: idle (unbekannter Plan "${planName}")`,
                ack: true,
            });
            return;
        }

        const activeValveIndexes = this.buildActiveValveList(config, plan);
        if (activeValveIndexes.length === 0) {
            this.deps.adapter.log.warn(`No active valves for plan "${planName}" today.`);
            await this.deps.adapter.setStateAsync('automation.status', {
                val: `Mode: idle (keine aktiven Ventile heute für Plan "${planName}")`,
                ack: true,
            });
            return;
        }

        this.activePlanName = plan.name;
        await this.deps.adapter.setStateAsync('automation.planSelect', { val: plan.name, ack: true });
        await this.updateTemperatureAdjustmentFactor(config);

        this.batches = buildBatches(activeValveIndexes, config.valves, config.scheduler.pumpCapacity);
        this.currentBatchIndex = -1;
        this.totalDurationMin = this.computeTotalDurationMin(config);
        this.startedAtMs = Date.now();
        this.valvePauseMs = config.scheduler.valvePause * 60 * 1000;

        if (this.deps.isLegallyRestricted()) {
            this.deps.adapter.log.warn(`Plan "${plan.name}" prepared but legal restriction is active - waiting.`);
            this.status = 'paused';
            this.blockedByLegalRestriction = true;
            this.pauseReason = this.computeDisplayPauseReason();
            await this.publishStatus();
            return;
        }

        this.status = 'running';
        await this.startNextBatch();
    }

    private async updateTemperatureAdjustmentFactor(config: IrrigationNativeConfig): Promise<void> {
        this.temperatureAdjustmentFactor = 1;
        if (!config.scheduler.temperatureAdjustmentEnabled || !config.scheduler.temperatureAdjustmentStateId) {
            await this.deps.adapter.setStateAsync('automation.temperatureAdjustmentFactor', { val: 1, ack: true });
            return;
        }
        try {
            const temperature = await this.deps.getTemperatureAdjustmentTemperature();
            if (temperature === undefined) {
                throw new Error('configured temperature state has no valid numeric value');
            }
            this.temperatureAdjustmentFactor = calculateTemperatureAdjustmentFactor(temperature);
            await this.deps.adapter.setStateAsync('automation.temperatureAdjustmentFactor', {
                val: this.temperatureAdjustmentFactor,
                ack: true,
            });
        } catch (error) {
            this.deps.adapter.log.warn(
                `Temperature-controlled irrigation adjustment disabled for this plan: ${(error as Error).message}`,
            );
            await this.deps.adapter.setStateAsync('automation.temperatureAdjustmentFactor', { val: 1, ack: true });
        }
    }

    private buildActiveValveList(config: IrrigationNativeConfig, plan: IPlanConfig): number[] {
        const useAllValves = plan.valveIndexes.length === 0;
        const requestedIndexes = config.valves
            .map((_, index) => index)
            .filter(index => useAllValves || plan.valveIndexes.includes(index));
        const weekday = new Date().getDay();
        const result: number[] = [];
        const seenIndexes = new Set<number>();
        for (const index of requestedIndexes) {
            if (seenIndexes.has(index)) {
                continue;
            }
            seenIndexes.add(index);
            const valve = config.valves[index];
            if (!valve || !valve.enabled) {
                continue;
            }
            if (valve.days.length > 0 && !valve.days.includes(weekday)) {
                continue;
            }
            const blocked = this.deps.isValveBlockedForAutoRun(index);
            if (blocked.blocked) {
                this.deps.adapter.log.debug(`Valve ${valve.name} skipped: ${blocked.reason}`);
                continue;
            }
            result.push(index);
        }
        return result;
    }

    private computeTotalDurationMin(config: IrrigationNativeConfig): number {
        let totalSeconds = 0;
        for (const batch of this.batches) {
            totalSeconds += Math.max(...batch.map(idx => this.effectiveDuration(config, idx)));
        }
        if (config.scheduler.valvePause > 0 && this.batches.length > 1) {
            totalSeconds += config.scheduler.valvePause * 60 * (this.batches.length - 1);
        }
        return totalSeconds / 60;
    }

    private effectiveDuration(config: IrrigationNativeConfig, valveIndex: number): number {
        return config.valves[valveIndex].duration * config.scheduler.extensionFactor * this.temperatureAdjustmentFactor;
    }

    /**
     * Computes the "logical" elapsed time (in seconds) that would have passed
     * once `targetBatchIndex` batches have completed and the batch at that
     * index is about to start: the sum of the (max) durations of all batches
     * before `targetBatchIndex`, plus one `valvePause` for each transition
     * between them. This mirrors the pause/duration accounting used by
     * `computeTotalDurationMin()`.
     *
     * @param config
     * @param targetBatchIndex
     */
    private computeElapsedSecsUpToBatch(config: IrrigationNativeConfig, targetBatchIndex: number): number {
        let secs = 0;
        for (let i = 0; i < targetBatchIndex && i < this.batches.length; i++) {
            secs += Math.round(Math.max(...this.batches[i].map(idx => this.effectiveDuration(config, idx))));
        }
        if (config.scheduler.valvePause > 0) {
            const pauseCount = Math.max(0, Math.min(targetBatchIndex, this.batches.length - 1));
            secs += config.scheduler.valvePause * 60 * pauseCount;
        }
        return secs;
    }

    /**
     * Resyncs `startedAtMs` so that `automation.remainingTime`/`automation.elapsedTime`
     * (computed from `startedAtMs` and `totalDurationMin` in `publishStatus()`) reflect
     * the batches actually still ahead after a manual Next/Back skip, rather than the
     * real wall-clock time elapsed since the run originally started. Without this, Next
     * jumping ahead (or Back jumping behind) would leave the remaining-time estimate
     * based on the original linear timeline, which no longer matches reality once
     * batches are skipped or repeated.
     *
     * @param targetBatchIndex Index of the batch that is about to start (or, when
     *   paused, the batch that will start once resumed).
     */
    private resyncStartedAtForBatchIndex(targetBatchIndex: number): void {
        if (this.batches.length === 0) {
            return;
        }
        const config = this.deps.getConfig();
        const elapsedSecs = this.computeElapsedSecsUpToBatch(config, targetBatchIndex);
        this.startedAtMs = Date.now() - elapsedSecs * 1000;
    }

    private async startNextBatch(): Promise<void> {
        this.currentBatchIndex++;
        if (this.currentBatchIndex >= this.batches.length) {
            await this.finishRun();
            return;
        }

        const config = this.deps.getConfig();
        const batch = this.batches[this.currentBatchIndex];
        this.runningValves = new Set(batch);
        this.inBatchPause = false;

        for (const valveIndex of batch) {
            const durationSecs = Math.round(this.effectiveDuration(config, valveIndex));
            this.valveDurationSecs.set(valveIndex, durationSecs);
            this.valveEndsAt.set(valveIndex, Date.now() + durationSecs * 1000);
            await this.deps.valves[valveIndex].start(durationSecs);
            this.deps.onValveFlowChange?.(valveIndex, true);
        }

        await this.deps.adapter.setStateAsync('automation.currentBatch', {
            val: this.currentBatchIndex + 1,
            ack: true,
        });
        await this.deps.adapter.setStateAsync('automation.totalBatches', { val: this.batches.length, ack: true });
        await this.deps.adapter.setStateAsync('automation.batchValves', {
            val: JSON.stringify(batch),
            ack: true,
        });
        await this.publishStatus();
    }

    private async finishRun(): Promise<void> {
        this.status = 'idle';
        this.clearAllBlockers();
        this.activePlanName = null;
        this.batches = [];
        this.currentBatchIndex = -1;
        this.runningValves.clear();
        await this.deps.adapter.setStateAsync('automation.currentBatch', { val: 0, ack: true });
        await this.deps.adapter.setStateAsync('automation.batchValves', { val: '[]', ack: true });
        await this.publishStatus();
    }

    // ------------------------------------------------------------------
    // Tick / batch pause / watchdog handling
    // ------------------------------------------------------------------

    private async tick(): Promise<void> {
        if (this.manualRun) {
            if (Date.now() >= this.manualRun.endsAt) {
                await this.finishManualRun();
            } else {
                // Only re-publish status when the displayed remaining-minutes value
                // actually changes, instead of on every tick, since publishStatus()
                // performs a double-digit number of setStateAsync writes.
                const remainingSecs = Math.max(0, Math.round((this.manualRun.endsAt - Date.now()) / 1000));
                const remainingMin = Math.ceil(remainingSecs / 60);
                if (remainingMin !== this.lastManualRunRemainingMin) {
                    this.lastManualRunRemainingMin = remainingMin;
                    await this.publishStatus();
                }
            }
            return;
        }

        if (this.status !== 'running') {
            return;
        }

        if (this.inBatchPause) {
            if (Date.now() >= this.batchPauseEndsAt) {
                this.inBatchPause = false;
                await this.startNextBatch();
            } else {
                await this.publishStatus();
            }
            return;
        }

        // Check whether all valves in the current batch have finished (device-driven
        // shutoff for Gardena/Rainbird, or adapter-owned timer for Homematic/Generic).
        const stillRunning = [...this.runningValves].filter(idx => Date.now() < (this.valveEndsAt.get(idx) ?? 0));
        if (stillRunning.length !== this.runningValves.size) {
            for (const idx of this.runningValves) {
                if (!stillRunning.includes(idx)) {
                    this.deps.onValveFlowChange?.(idx, false);
                }
            }
            this.runningValves = new Set(stillRunning);
        }

        if (this.runningValves.size === 0) {
            const config = this.deps.getConfig();
            if (config.scheduler.valvePause > 0 && this.currentBatchIndex < this.batches.length - 1) {
                this.inBatchPause = true;
                this.batchPauseEndsAt = Date.now() + this.valvePauseMs;
                await this.publishStatus();
            } else {
                await this.startNextBatch();
            }
            return;
        }

        await this.publishStatus();
    }

    // ------------------------------------------------------------------
    // Controls: stop / pause / next / back
    // ------------------------------------------------------------------

    public async stop(): Promise<void> {
        if (this.manualRun) {
            await this.stopManualRun();
            await this.resetDurationStates();
            return;
        }
        if (this.status === 'idle') {
            await this.resetDurationStates();
            return;
        }

        await this.stopRunningValves();
        this.runningValves.clear();
        await this.resetDurationStates();
        await this.finishRun();
    }

    /**
     * Stops every valve currently in `runningValves` and notifies
     * `onValveFlowChange(idx, false)` for each. Shared by stop(), pause(),
     * setRainPause(), setWindPause(), next(), back(), manualStartValve(),
     * and onLegalRestrictionChanged() so this stop-and-notify sequence
     * cannot silently diverge between callers.
     */
    private async stopRunningValves(): Promise<void> {
        for (const idx of this.runningValves) {
            await this.deps.valves[idx].stop();
            this.deps.onValveFlowChange?.(idx, false);
        }
    }

    /**
     * Restarts every valve currently in `runningValves` with its remaining
     * time (from `valveEndsAt`) and notifies `onValveFlowChange(idx, true)`
     * for each. Shared by tryResume() (used by pause()/setRainPause()/
     * setWindPause()/onLegalRestrictionChanged()'s resume paths) and
     * finishManualRun(). Valves whose remaining time has already elapsed
     * are skipped rather than restarted with 0/negative duration.
     */
    private async resumeRunningValves(): Promise<void> {
        for (const idx of this.runningValves) {
            const remaining = Math.max(0, Math.round(((this.valveEndsAt.get(idx) ?? 0) - Date.now()) / 1000));
            if (remaining > 0) {
                await this.deps.valves[idx].start(remaining);
                // CRITICAL: valveEndsAt was set as an absolute timestamp when the
                // batch originally started (startNextBatch()) and must be
                // refreshed here to reflect the actual remaining time just
                // restarted with. Without this, every pause/resume cycle silently
                // shortens the real watering time: tick() compares
                // Date.now() < valveEndsAt to decide whether a valve is still
                // running, using the *original* (now stale) end time, so it would
                // consider the valve finished as soon as that original timestamp
                // passes - regardless of how long it was actually paused for.
                this.valveEndsAt.set(idx, Date.now() + remaining * 1000);
                this.deps.onValveFlowChange?.(idx, true);
            }
        }
    }

    public async pause(): Promise<void> {
        if (this.manualRun) {
            return;
        } // manual runs only support start/stop
        if (this.status === 'running') {
            await this.stopRunningValves();
            this.status = 'paused';
            this.blockedManually = true;
            this.pauseReason = this.computeDisplayPauseReason();
            await this.publishStatus();
        } else if (this.status === 'paused') {
            this.blockedManually = false;
            await this.tryResume();
        }
    }

    public async setRainPause(raining: boolean): Promise<void> {
        if (this.manualRun || !this.deps.getConfig().scheduler.pauseOnRain) {
            return;
        }
        if (raining) {
            if (this.status === 'running') {
                await this.stopRunningValves();
                this.status = 'paused';
            }
            if (this.status === 'paused') {
                this.blockedByRain = true;
                this.pauseReason = this.computeDisplayPauseReason();
                await this.publishStatus();
            }
            return;
        }
        if (this.blockedByRain) {
            this.blockedByRain = false;
            await this.tryResume();
        }
    }

    public async setWindPause(paused: boolean): Promise<void> {
        if (this.manualRun || !this.deps.getConfig().scheduler.windPauseEnabled) {
            return;
        }
        if (paused) {
            if (this.status === 'running') {
                await this.stopRunningValves();
                this.status = 'paused';
            }
            if (this.status === 'paused') {
                this.blockedByWind = true;
                this.pauseReason = this.computeDisplayPauseReason();
                await this.publishStatus();
            }
            return;
        }
        if (this.blockedByWind) {
            this.blockedByWind = false;
            await this.tryResume();
        }
    }

    public async next(): Promise<void> {
        if (this.manualRun) {
            return;
        } // ignored during manual run, see priority table
        if (this.status !== 'running' && this.status !== 'paused') {
            return;
        }
        await this.stopRunningValves();
        this.runningValves.clear();
        this.inBatchPause = false;
        if (this.status === 'paused') {
            // stay paused, do not auto-start the next batch (see plan Next/Back rules)
            this.currentBatchIndex++;
            this.resyncStartedAtForBatchIndex(this.currentBatchIndex);
            await this.publishStatus();
            return;
        }
        this.resyncStartedAtForBatchIndex(this.currentBatchIndex + 1);
        await this.startNextBatch();
    }

    public async back(): Promise<void> {
        if (this.manualRun) {
            return;
        }
        if (this.status !== 'running' && this.status !== 'paused') {
            return;
        }
        await this.stopRunningValves();
        this.runningValves.clear();
        this.inBatchPause = false;
        if (this.currentBatchIndex > 0) {
            this.currentBatchIndex -= 2; // startNextBatch() will increment back to the previous batch
        } else {
            this.currentBatchIndex = -1;
        }
        if (this.status === 'paused') {
            this.currentBatchIndex++;
            this.resyncStartedAtForBatchIndex(this.currentBatchIndex);
            await this.publishStatus();
            return;
        }
        this.resyncStartedAtForBatchIndex(this.currentBatchIndex + 1);
        await this.startNextBatch();
    }

    // ------------------------------------------------------------------
    // Manual single-valve runs
    // ------------------------------------------------------------------

    public async manualSetValveState(valveIndex: number, requestedOn: boolean): Promise<void> {
        if (requestedOn) {
            await this.manualStartValve(valveIndex);
            return;
        }
        if (this.manualRun?.valveIndex === valveIndex) {
            await this.stopManualRun();
            return;
        }
        await this.deps.valves[valveIndex]?.stop();
        this.deps.onValveFlowChange?.(valveIndex, false);
    }

    public async manualStartValve(valveIndex: number): Promise<void> {
        if (this.manualRun) {
            this.deps.adapter.log.warn('Manual valve start ignored: another manual run is already active.');
            return;
        }

        const config = this.deps.getConfig();
        const valve = config.valves[valveIndex];
        if (!valve) {
            this.deps.adapter.log.error(`Manual start for valve ${valveIndex} failed: valve not found.`);
            return;
        }
        if (!valve.enabled) {
            this.deps.adapter.log.warn(
                `Manual start for valve ${valve.name} ignored: valve is disabled. The running automation, if any, was left untouched.`,
            );
            return;
        }

        this.wasAutomationPausedForManual = false;
        if (this.status === 'running') {
            await this.stopRunningValves();
            this.status = 'paused';
            this.blockedManually = true;
            this.pauseReason = this.computeDisplayPauseReason();
            this.wasAutomationPausedForManual = true;
        }

        const durationSecs = Math.round(valve.manualDuration);
        this.manualRun = { valveIndex, endsAt: Date.now() + durationSecs * 1000 };
        this.lastManualRunRemainingMin = Math.ceil(durationSecs / 60);
        await this.deps.valves[valveIndex].start(durationSecs);
        this.deps.onValveFlowChange?.(valveIndex, true);
        await this.publishStatus();
    }

    private async finishManualRun(): Promise<void> {
        if (!this.manualRun) {
            return;
        }
        await this.deps.valves[this.manualRun.valveIndex].stop();
        this.deps.onValveFlowChange?.(this.manualRun.valveIndex, false);
        this.manualRun = null;

        if (this.wasAutomationPausedForManual) {
            this.wasAutomationPausedForManual = false;
            this.blockedManually = false;
            // Resume the batch that was interrupted for the manual run, exactly as
            // pause()/resume does: restart the same valves (still tracked in
            // runningValves/valveEndsAt, never cleared for a manual-run interruption)
            // with their remaining time - but only if no other blocker (rain, wind,
            // legal restriction) became active in the meantime, since tryResume()
            // re-checks all of them live rather than blindly resuming.
            await this.tryResume();
        } else {
            await this.publishStatus();
        }
    }

    private async stopManualRun(): Promise<void> {
        if (!this.manualRun) {
            return;
        }
        await this.deps.valves[this.manualRun.valveIndex].stop();
        this.deps.onValveFlowChange?.(this.manualRun.valveIndex, false);
        this.manualRun = null;
        // Per priority table: stop during manual run also resets automation to idle (not resumed)
        this.wasAutomationPausedForManual = false;
        await this.finishRun();
    }

    // ------------------------------------------------------------------
    // Legal restriction integration (called by dwd.ts)
    // ------------------------------------------------------------------

    public async onLegalRestrictionChanged(active: boolean): Promise<void> {
        if (active) {
            if (this.status === 'running') {
                await this.stopRunningValves();
                this.status = 'paused';
            }
            if (this.status === 'paused') {
                this.blockedByLegalRestriction = true;
                this.pauseReason = this.computeDisplayPauseReason();
                await this.publishStatus();
            }
            return;
        }
        if (this.blockedByLegalRestriction) {
            this.blockedByLegalRestriction = false;
            await this.tryResume();
        }
    }

    // ------------------------------------------------------------------
    // Status text
    // ------------------------------------------------------------------

    private async resetDurationStates(): Promise<void> {
        this.startedAtMs = 0;
        this.totalDurationMin = 0;
        this.temperatureAdjustmentFactor = 1;
        await this.deps.adapter.setStateAsync('automation.elapsedTime', { val: 0, ack: true });
        await this.deps.adapter.setStateAsync('automation.remainingDuration', { val: 0, ack: true });
        await this.deps.adapter.setStateAsync('automation.remainingDurationMin', { val: formatDuration(0), ack: true });
        await this.deps.adapter.setStateAsync('automation.totalDuration', { val: 0, ack: true });
        await this.deps.adapter.setStateAsync('automation.temperatureAdjustmentFactor', { val: 1, ack: true });
    }

    private async publishStatus(): Promise<void> {
        const config = this.deps.getConfig();
        let text = `Mode: ${this.status}`;
        if (this.manualRun) {
            const valve = config.valves[this.manualRun.valveIndex];
            const remainingSecs = Math.max(0, Math.round((this.manualRun.endsAt - Date.now()) / 1000));
            text = `Mode: manual (${valve?.name ?? this.manualRun.valveIndex}, noch ${Math.ceil(remainingSecs / 60)}min)`;
        } else if (this.status !== 'idle' && this.activePlanName) {
            text += ` (Plan: ${this.activePlanName})`;
            if (this.pauseReason === 'legalRestriction') {
                text += ' (gesetzliche Beregnungssperre aktiv)';
            }
            if (this.inBatchPause) {
                const remaining = Math.max(0, Math.round((this.batchPauseEndsAt - Date.now()) / 1000 / 60));
                text += ` - Pause (Versickerung), noch ${remaining}min`;
            } else if (this.runningValves.size > 0) {
                const valveNames = [...this.runningValves]
                    .map(idx => {
                        const remaining = Math.max(
                            0,
                            Math.round(((this.valveEndsAt.get(idx) ?? 0) - Date.now()) / 1000 / 60),
                        );
                        return `${config.valves[idx]?.name ?? idx} (${remaining}min)`;
                    })
                    .join(', ');
                text += ` - Batch ${this.currentBatchIndex + 1}/${this.batches.length}: ${valveNames}`;
            }
        }

        await this.deps.adapter.setStateAsync('automation.status', { val: text, ack: true });
        await this.deps.adapter.setStateAsync('automation.running', {
            val: this.status === 'running' || this.status === 'paused' || this.manualRun !== null,
            ack: true,
        });

        const elapsedSecs = this.startedAtMs > 0 ? Math.floor((Date.now() - this.startedAtMs) / 1000) : 0;
        const totalDurationSecs = this.totalDurationMin * 60;
        const remainingSecs = Math.max(0, totalDurationSecs - elapsedSecs);
        await this.deps.adapter.setStateAsync('automation.elapsedTime', { val: elapsedSecs, ack: true });
        await this.deps.adapter.setStateAsync('automation.remainingDuration', {
            val: remainingSecs,
            ack: true,
        });
        await this.deps.adapter.setStateAsync('automation.remainingDurationMin', {
            val: formatDuration(remainingSecs),
            ack: true,
        });
        await this.deps.adapter.setStateAsync('automation.totalDuration', { val: totalDurationSecs, ack: true });
        await this.deps.adapter.setStateAsync('automation.activePlan', { val: this.activePlanName ?? '', ack: true });
        await this.deps.adapter.setStateAsync('automation.currentValve', {
            val: this.runningValves.size > 0 ? [...this.runningValves][0] : -1,
            ack: true,
        });
    }
}
