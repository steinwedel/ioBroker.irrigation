import type { IrrigationNativeConfig, IZoneConfig, AutomationStatus, PauseReason, Batch } from './types';
import type { ValveController } from './ventile';
import type { ZoneController } from './zonen';

export interface AutomationDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    valves: ValveController[];
    zones: ZoneController[];
    /** Returns true if the zone should be skipped for automatic runs right now (sensors, weekday, ...) */
    isZoneBlockedForAutoRun: (zoneIndex: number) => {
        blocked: boolean;
        reason?: string;
    };
    /** True if a legal restriction currently blocks watering */
    isLegallyRestricted: () => boolean;
    /** Called whenever water starts/stops flowing through a zone, for consumption tracking */
    onZoneFlowChange?: (zoneIndex: number, flowing: boolean) => void;
}

/**
 * Builds parallel batches of zone indexes from a flat list, respecting the
 * pump capacity constraint. See plan section
 * "Pumpenkapazität & Parallele Optimierung".
 *
 * Greedy bin-packing: zones sorted by duration descending; each zone is
 * placed into the existing batch whose total duration would grow the least
 * while staying within pumpCapacity, otherwise a new batch is created.
 *
 * @param zoneIndexes
 * @param zones
 * @param pumpCapacity
 */
export function buildBatches(zoneIndexes: number[], zones: IZoneConfig[], pumpCapacity: number): Batch[] {
    if (pumpCapacity <= 0) {
        // Sequential mode: one zone per batch, preserve original order
        return zoneIndexes.map(idx => [idx]);
    }

    const sorted = [...zoneIndexes].sort((a, b) => zones[b].duration - zones[a].duration);

    interface WorkingBatch {
        zoneIdxs: number[];
        flowSum: number;
        duration: number;
    }
    const batches: WorkingBatch[] = [];

    for (const zoneIdx of sorted) {
        const zone = zones[zoneIdx];
        const flowRate = zone.flowRate || 0;

        let bestBatch: WorkingBatch | undefined;
        let bestIncrease = Infinity;

        for (const batch of batches) {
            if (batch.flowSum + flowRate > pumpCapacity) {
                continue;
            }
            const increase = Math.max(0, zone.duration - batch.duration);
            if (increase < bestIncrease) {
                bestIncrease = increase;
                bestBatch = batch;
            }
        }

        if (bestBatch) {
            bestBatch.zoneIdxs.push(zoneIdx);
            bestBatch.flowSum += flowRate;
            bestBatch.duration = Math.max(bestBatch.duration, zone.duration);
        } else {
            batches.push({ zoneIdxs: [zoneIdx], flowSum: flowRate, duration: zone.duration });
        }
    }

    return batches.map(b => b.zoneIdxs);
}

export class AutomationEngine {
    private readonly deps: AutomationDeps;

    private status: AutomationStatus = 'idle';
    private pauseReason: PauseReason = null;
    private activePlanName: string | null = null;
    private batches: Batch[] = [];
    private currentBatchIndex = -1;
    private runningZones = new Set<number>();
    private zoneEndsAt = new Map<number, number>();
    private zoneDurationSecs = new Map<number, number>();
    private inBatchPause = false;
    private batchPauseEndsAt = 0;
    private totalDurationMin = 0;
    private startedAtMs = 0;

    private manualRun: {
        zoneIndex: number;
        endsAt: number;
    } | null = null;
    private wasAutomationPausedForManual = false;
    private wasAutomationBatchIndexBeforeManual = -1;

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
     * Called once at adapter start. If the persisted automation state claims
     * a run was in progress, all valves are closed defensively and the
     * automation is reset to idle - see plan "Config-Änderung während
     * Laufzeit" / risk "Compact Mode".
     */
    public async recoverAfterRestart(): Promise<void> {
        for (const valve of this.deps.valves) {
            await valve.stop();
        }
        this.status = 'idle';
        this.pauseReason = null;
        this.activePlanName = null;
        this.batches = [];
        this.currentBatchIndex = -1;
        this.runningZones.clear();
        this.manualRun = null;
        await this.publishStatus();
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
            this.deps.adapter.log.warn(`Run request (${source}) ignored: manual zone run in progress.`);
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

        const activeZoneIndexes = this.buildActiveZoneList(config, plan.groups);
        if (activeZoneIndexes.length === 0) {
            this.deps.adapter.log.warn(`No active zones for plan "${planName}" today.`);
            await this.deps.adapter.setStateAsync('automation.status', {
                val: `Mode: idle (keine aktiven Zonen heute für Plan "${planName}")`,
                ack: true,
            });
            return;
        }

        this.activePlanName = plan.name;
        await this.deps.adapter.setStateAsync('automation.planSelect', { val: plan.name, ack: true });

        this.batches = buildBatches(activeZoneIndexes, config.zones, config.scheduler.pumpCapacity);
        this.currentBatchIndex = -1;
        this.totalDurationMin = this.computeTotalDurationMin(config);
        this.startedAtMs = Date.now();

        if (this.deps.isLegallyRestricted()) {
            this.deps.adapter.log.warn(`Plan "${plan.name}" prepared but legal restriction is active - waiting.`);
            this.status = 'paused';
            this.pauseReason = 'legalRestriction';
            await this.publishStatus();
            return;
        }

        this.status = 'running';
        await this.startNextBatch();
    }

    /**
     * Zones belonging to the plan's groups, filtered by enabled/day/sensors. See plan buildActiveBeete() equivalent.
     *
     * @param config
     * @param planGroups
     */
    private buildActiveZoneList(config: IrrigationNativeConfig, planGroups: string[]): number[] {
        const weekday = new Date().getDay();
        const result: number[] = [];
        for (let i = 0; i < config.zones.length; i++) {
            const zone = config.zones[i];
            if (!zone.enabled) {
                continue;
            }
            if (zone.valveIndex < 0 || zone.valveIndex >= config.valves.length) {
                continue;
            }
            if (zone.days.length > 0 && !zone.days.includes(weekday)) {
                continue;
            }
            if (planGroups.length > 0 && !zone.groups.some(g => planGroups.includes(g))) {
                continue;
            }
            const blocked = this.deps.isZoneBlockedForAutoRun(i);
            if (blocked.blocked) {
                this.deps.adapter.log.debug(`Zone ${zone.name} skipped: ${blocked.reason}`);
                continue;
            }
            result.push(i);
        }
        return result;
    }

    private computeTotalDurationMin(config: IrrigationNativeConfig): number {
        let total = 0;
        for (const batch of this.batches) {
            const batchDuration = Math.max(...batch.map(idx => this.effectiveDuration(config, idx)));
            total += batchDuration;
        }
        if (config.scheduler.zonePause > 0 && this.batches.length > 1) {
            total += config.scheduler.zonePause * (this.batches.length - 1);
        }
        return total;
    }

    private effectiveDuration(config: IrrigationNativeConfig, zoneIndex: number): number {
        return config.zones[zoneIndex].duration * config.scheduler.extensionFactor;
    }

    private async startNextBatch(): Promise<void> {
        this.currentBatchIndex++;
        if (this.currentBatchIndex >= this.batches.length) {
            await this.finishRun();
            return;
        }

        const config = this.deps.getConfig();
        const batch = this.batches[this.currentBatchIndex];
        this.runningZones = new Set(batch);
        this.inBatchPause = false;

        for (const zoneIndex of batch) {
            const zone = config.zones[zoneIndex];
            const durationSecs = Math.round(this.effectiveDuration(config, zoneIndex) * 60);
            this.zoneDurationSecs.set(zoneIndex, durationSecs);
            this.zoneEndsAt.set(zoneIndex, Date.now() + durationSecs * 1000);
            await this.deps.valves[zone.valveIndex].start(durationSecs);
            this.deps.onZoneFlowChange?.(zoneIndex, true);
        }

        await this.deps.adapter.setStateAsync('automation.currentBatch', {
            val: this.currentBatchIndex + 1,
            ack: true,
        });
        await this.deps.adapter.setStateAsync('automation.totalBatches', { val: this.batches.length, ack: true });
        await this.deps.adapter.setStateAsync('automation.batchZones', {
            val: JSON.stringify(batch),
            ack: true,
        });
        await this.publishStatus();
    }

    private async finishRun(): Promise<void> {
        this.status = 'idle';
        this.pauseReason = null;
        this.activePlanName = null;
        this.batches = [];
        this.currentBatchIndex = -1;
        this.runningZones.clear();
        await this.deps.adapter.setStateAsync('automation.currentBatch', { val: 0, ack: true });
        await this.deps.adapter.setStateAsync('automation.batchZones', { val: '[]', ack: true });
        await this.publishStatus();
    }

    // ------------------------------------------------------------------
    // Tick / batch pause / watchdog handling
    // ------------------------------------------------------------------

    private async tick(): Promise<void> {
        if (this.manualRun) {
            if (Date.now() >= this.manualRun.endsAt) {
                await this.finishManualRun();
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

        // Check whether all zones in the current batch have finished (device-driven
        // shutoff for Gardena/Rainbird, or adapter-owned timer for Homematic/Generic).
        const stillRunning = [...this.runningZones].filter(idx => Date.now() < (this.zoneEndsAt.get(idx) ?? 0));
        if (stillRunning.length !== this.runningZones.size) {
            for (const idx of this.runningZones) {
                if (!stillRunning.includes(idx)) {
                    this.deps.onZoneFlowChange?.(idx, false);
                }
            }
            this.runningZones = new Set(stillRunning);
        }

        if (this.runningZones.size === 0) {
            const config = this.deps.getConfig();
            if (config.scheduler.zonePause > 0 && this.currentBatchIndex < this.batches.length - 1) {
                this.inBatchPause = true;
                this.batchPauseEndsAt = Date.now() + config.scheduler.zonePause * 60 * 1000;
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
            return;
        }
        if (this.status === 'idle') {
            return;
        }

        for (const idx of this.runningZones) {
            const config = this.deps.getConfig();
            await this.deps.valves[config.zones[idx].valveIndex].stop();
            this.deps.onZoneFlowChange?.(idx, false);
        }
        this.runningZones.clear();
        await this.finishRun();
    }

    public async pause(): Promise<void> {
        if (this.manualRun) {
            return;
        } // manual runs only support start/stop
        if (this.status === 'running') {
            for (const idx of this.runningZones) {
                const config = this.deps.getConfig();
                await this.deps.valves[config.zones[idx].valveIndex].stop();
            }
            this.status = 'paused';
            this.pauseReason = 'manual';
            await this.publishStatus();
        } else if (this.status === 'paused') {
            if (this.pauseReason === 'legalRestriction' && this.deps.isLegallyRestricted()) {
                this.deps.adapter.log.warn('Resume refused: legal restriction still active.');
                return;
            }
            this.status = 'running';
            this.pauseReason = null;
            const config = this.deps.getConfig();
            for (const idx of this.runningZones) {
                const remaining = Math.max(0, Math.round(((this.zoneEndsAt.get(idx) ?? 0) - Date.now()) / 1000));
                await this.deps.valves[config.zones[idx].valveIndex].start(remaining);
            }
            await this.publishStatus();
        }
    }

    public async next(): Promise<void> {
        if (this.manualRun) {
            return;
        } // ignored during manual run, see priority table
        if (this.status !== 'running' && this.status !== 'paused') {
            return;
        }
        for (const idx of this.runningZones) {
            const config = this.deps.getConfig();
            await this.deps.valves[config.zones[idx].valveIndex].stop();
            this.deps.onZoneFlowChange?.(idx, false);
        }
        this.runningZones.clear();
        this.inBatchPause = false;
        if (this.status === 'paused') {
            // stay paused, do not auto-start the next batch (see plan Next/Back rules)
            this.currentBatchIndex++;
            await this.publishStatus();
            return;
        }
        await this.startNextBatch();
    }

    public async back(): Promise<void> {
        if (this.manualRun) {
            return;
        }
        if (this.status !== 'running' && this.status !== 'paused') {
            return;
        }
        for (const idx of this.runningZones) {
            const config = this.deps.getConfig();
            await this.deps.valves[config.zones[idx].valveIndex].stop();
            this.deps.onZoneFlowChange?.(idx, false);
        }
        this.runningZones.clear();
        this.inBatchPause = false;
        if (this.currentBatchIndex > 0) {
            this.currentBatchIndex -= 2; // startNextBatch() will increment back to the previous batch
        } else {
            this.currentBatchIndex = -1;
        }
        if (this.status === 'paused') {
            this.currentBatchIndex++;
            await this.publishStatus();
            return;
        }
        await this.startNextBatch();
    }

    // ------------------------------------------------------------------
    // Manual single-zone runs
    // ------------------------------------------------------------------

    public async manualStartZone(zoneIndex: number): Promise<void> {
        if (this.manualRun) {
            this.deps.adapter.log.warn('Manual zone start ignored: another manual run is already active.');
            return;
        }

        const config = this.deps.getConfig();
        const zone = config.zones[zoneIndex];
        if (!zone || zone.valveIndex < 0 || zone.valveIndex >= config.valves.length) {
            this.deps.adapter.log.error(`Manual start for zone ${zoneIndex} failed: invalid valve reference.`);
            return;
        }

        this.wasAutomationPausedForManual = false;
        if (this.status === 'running') {
            for (const idx of this.runningZones) {
                await this.deps.valves[config.zones[idx].valveIndex].stop();
            }
            this.wasAutomationBatchIndexBeforeManual = this.currentBatchIndex;
            this.status = 'paused';
            this.pauseReason = 'manual';
            this.wasAutomationPausedForManual = true;
        }

        const durationSecs = Math.round(zone.manualDuration * 60);
        this.manualRun = { zoneIndex, endsAt: Date.now() + durationSecs * 1000 };
        await this.deps.valves[zone.valveIndex].start(durationSecs);
        this.deps.onZoneFlowChange?.(zoneIndex, true);
        await this.publishStatus();
    }

    private async finishManualRun(): Promise<void> {
        if (!this.manualRun) {
            return;
        }
        const config = this.deps.getConfig();
        const zone = config.zones[this.manualRun.zoneIndex];
        if (zone) {
            await this.deps.valves[zone.valveIndex].stop();
            this.deps.onZoneFlowChange?.(this.manualRun.zoneIndex, false);
        }
        this.manualRun = null;

        if (this.wasAutomationPausedForManual) {
            this.status = 'running';
            this.pauseReason = null;
            this.currentBatchIndex = this.wasAutomationBatchIndexBeforeManual;
            await this.startNextBatch();
        } else {
            await this.publishStatus();
        }
    }

    private async stopManualRun(): Promise<void> {
        if (!this.manualRun) {
            return;
        }
        const config = this.deps.getConfig();
        const zone = config.zones[this.manualRun.zoneIndex];
        if (zone) {
            await this.deps.valves[zone.valveIndex].stop();
            this.deps.onZoneFlowChange?.(this.manualRun.zoneIndex, false);
        }
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
                for (const idx of this.runningZones) {
                    const config = this.deps.getConfig();
                    await this.deps.valves[config.zones[idx].valveIndex].stop();
                }
                this.status = 'paused';
                this.pauseReason = 'legalRestriction';
                await this.publishStatus();
            } else if (this.status === 'paused' && this.pauseReason === null) {
                this.pauseReason = 'legalRestriction';
            }
        } else if (this.pauseReason === 'legalRestriction') {
            this.pauseReason = null;
            if (this.status === 'paused') {
                if (this.currentBatchIndex === -1) {
                    // was prepared but never started (see runPlan())
                    this.status = 'running';
                    await this.startNextBatch();
                } else {
                    this.status = 'running';
                    const config = this.deps.getConfig();
                    for (const idx of this.runningZones) {
                        const remaining = Math.max(
                            0,
                            Math.round(((this.zoneEndsAt.get(idx) ?? 0) - Date.now()) / 1000),
                        );
                        await this.deps.valves[config.zones[idx].valveIndex].start(remaining);
                    }
                    await this.publishStatus();
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Status text
    // ------------------------------------------------------------------

    private async publishStatus(): Promise<void> {
        const config = this.deps.getConfig();
        let text = `Mode: ${this.status}`;
        if (this.manualRun) {
            const zone = config.zones[this.manualRun.zoneIndex];
            const remainingSecs = Math.max(0, Math.round((this.manualRun.endsAt - Date.now()) / 1000));
            text = `Mode: manual (${zone?.name ?? this.manualRun.zoneIndex}, noch ${Math.ceil(remainingSecs / 60)}min)`;
        } else if (this.status !== 'idle' && this.activePlanName) {
            text += ` (Plan: ${this.activePlanName})`;
            if (this.pauseReason === 'legalRestriction') {
                text += ' (gesetzliche Beregnungssperre aktiv)';
            }
            if (this.inBatchPause) {
                const remaining = Math.max(0, Math.round((this.batchPauseEndsAt - Date.now()) / 1000 / 60));
                text += ` - Pause (Versickerung), noch ${remaining}min`;
            } else if (this.runningZones.size > 0) {
                const zoneNames = [...this.runningZones]
                    .map(idx => {
                        const remaining = Math.max(
                            0,
                            Math.round(((this.zoneEndsAt.get(idx) ?? 0) - Date.now()) / 1000 / 60),
                        );
                        return `${config.zones[idx]?.name ?? idx} (${remaining}min)`;
                    })
                    .join(', ');
                text += ` - Batch ${this.currentBatchIndex + 1}/${this.batches.length}: ${zoneNames}`;
            }
        }

        await this.deps.adapter.setStateAsync('automation.status', { val: text, ack: true });
        await this.deps.adapter.setStateAsync('automation.running', {
            val: this.status === 'running' || this.status === 'paused' || this.manualRun !== null,
            ack: true,
        });

        const elapsedMin = this.startedAtMs > 0 ? Math.floor((Date.now() - this.startedAtMs) / 60000) : 0;
        await this.deps.adapter.setStateAsync('automation.elapsedTime', { val: elapsedMin, ack: true });
        await this.deps.adapter.setStateAsync('automation.remainingTime', {
            val: Math.max(0, this.totalDurationMin - elapsedMin),
            ack: true,
        });
        await this.deps.adapter.setStateAsync('automation.totalDuration', { val: this.totalDurationMin, ack: true });
        await this.deps.adapter.setStateAsync('automation.activePlan', { val: this.activePlanName ?? '', ack: true });
        await this.deps.adapter.setStateAsync('automation.currentZone', {
            val: this.runningZones.size > 0 ? [...this.runningZones][0] : -1,
            ack: true,
        });
    }
}
