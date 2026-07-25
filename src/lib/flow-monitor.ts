import { formatValveNumber, type IrrigationNativeConfig } from './types';
import type { NotificationManager } from './notifications';

export interface FlowMonitorDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    notifications: NotificationManager;
    /** Indexes of valves currently running (automatic or manual) */
    getRunningValveIndexes: () => number[];
}

const DEVIATION_THRESHOLD_PCT = 30;
export const CALIBRATION_DURATION_SECS = 120;

/**
 * Monitors the single, shared flow sensor installed directly behind the
 * water source (e.g. the pump) - the supported hardware never has one flow
 * sensor per valve. Tracks actual vs. expected flow (summed across whichever
 * valves are currently running) for leak/clog detection, and implements the
 * per-valve calibration routine (which opens exactly one valve at a time so
 * the shared sensor's reading can be attributed to it).
 * See plan behavior rules "Durchfluss-Überwachung" and "Durchfluss-Kalibrierung".
 */
export class FlowMonitor {
    private readonly deps: FlowMonitorDeps;
    private subscribedId: string | undefined;
    private calibrationSamples: number[] = [];
    private calibratingValveIndex: number | undefined;
    private calibrationTimer: ReturnType<ioBroker.Adapter['setTimeout']> | undefined;

    public constructor(deps: FlowMonitorDeps) {
        this.deps = deps;
    }

    public async init(): Promise<void> {
        await this.resubscribe();
    }

    public async resubscribe(): Promise<void> {
        if (this.subscribedId) {
            await this.deps.adapter.unsubscribeForeignStatesAsync(this.subscribedId);
            this.subscribedId = undefined;
        }

        const config = this.deps.getConfig();
        const id = config.flowMonitor.enabled ? config.flowMonitor.sensorId.trim() : '';
        if (id) {
            await this.deps.adapter.subscribeForeignStatesAsync(id);
            this.subscribedId = id;
        }
    }

    public async onForeignStateChange(id: string, state: ioBroker.State | null | undefined): Promise<boolean> {
        if (id !== this.subscribedId) {
            return false;
        }

        const flow = typeof state?.val === 'number' ? state.val : 0;
        await this.deps.adapter.setStateAsync('watchdog.flowActual', { val: flow, ack: true });

        if (this.calibratingValveIndex !== undefined) {
            this.calibrationSamples.push(flow);
        } else {
            const runningIndexes = this.deps.getRunningValveIndexes();
            await this.checkDeviation(runningIndexes, flow);

            // Leak detection: any flow while nothing is running. Since there is only
            // one shared sensor for the whole installation, "nothing running" is a
            // reliable signal here - unlike a (hypothetical) per-valve sensor setup,
            // there is no "unrelated valve" that could make this fire spuriously.
            if (runningIndexes.length === 0 && flow > 0) {
                await this.reportLeak(flow);
            } else {
                await this.deps.adapter.setStateAsync('watchdog.flowActive', { val: false, ack: true });
            }
        }

        return true;
    }

    private async checkDeviation(runningIndexes: number[], actualFlow: number): Promise<void> {
        if (runningIndexes.length === 0) {
            return;
        }
        const config = this.deps.getConfig();
        let expected = 0;
        for (const idx of runningIndexes) {
            expected += await this.getExpectedFlow(idx);
        }
        if (expected <= 0) {
            return;
        }

        const deviationPct = ((actualFlow - expected) / expected) * 100;
        if (Math.abs(deviationPct) > DEVIATION_THRESHOLD_PCT) {
            const label =
                runningIndexes.length === 1
                    ? `Valve "${config.valves[runningIndexes[0]]?.name ?? runningIndexes[0]}"`
                    : `Valves ${runningIndexes.map(idx => `"${config.valves[idx]?.name ?? idx}"`).join(', ')}`;
            const message =
                deviationPct > 0
                    ? `${label}: Durchfluss ${Math.round(deviationPct)}% über Erwartung (Rohrbruch?)`
                    : `${label}: Durchfluss ${Math.round(Math.abs(deviationPct))}% unter Erwartung (Düsen verstopft?)`;

            await this.deps.adapter.setStateAsync('watchdog.flowDeviationValve', {
                val: runningIndexes.length === 1 ? runningIndexes[0] : -1,
                ack: true,
            });
            await this.deps.adapter.setStateAsync('watchdog.flowDeviationPct', {
                val: Math.round(deviationPct),
                ack: true,
            });
            await this.reportIssue(message);
        }
    }

    private async reportLeak(flow: number): Promise<void> {
        await this.deps.adapter.setStateAsync('watchdog.flowActive', { val: true, ack: true });
        await this.reportIssue(
            `Leck-Verdacht: Durchfluss ${flow}l/min am Durchflusssensor, obwohl alle Ventile geschlossen sind.`,
        );
    }

    private async reportIssue(message: string): Promise<void> {
        this.deps.adapter.log.warn(`Watchdog: ${message}`);
        await this.deps.adapter.setStateAsync('watchdog.lastIssue', { val: message, ack: true });
        await this.deps.adapter.setStateAsync('watchdog.lastIssueTs', { val: Date.now(), ack: true });
        const countState = await this.deps.adapter.getStateAsync('watchdog.issueCount');
        const count = (typeof countState?.val === 'number' ? countState.val : 0) + 1;
        await this.deps.adapter.setStateAsync('watchdog.issueCount', { val: count, ack: true });
        await this.deps.notifications.send('Bewässerung Watchdog', message);
    }

    /**
     * Builds the `valves.valve_XXX` object-id suffix for a valve's array
     * index. The real object id is derived from the valve's stable
     * `IValveConfig.id` (see ventile.ts's `id` getter), not its current
     * array position - the two can differ once valves have been
     * reordered/deleted/re-added, so this must never use `valveIndex`
     * directly.
     *
     * @param valveIndex
     */
    private objectSuffixFor(valveIndex: number): string {
        const config = this.deps.getConfig();
        return formatValveNumber(config.valves[valveIndex]?.id ?? valveIndex);
    }

    private async getExpectedFlow(valveIndex: number): Promise<number> {
        const state = await this.deps.adapter.getStateAsync(
            `valves.valve_${this.objectSuffixFor(valveIndex)}.flowExpected`,
        );
        return typeof state?.val === 'number' ? state.val : 0;
    }

    /**
     * Runs the calibration routine: opens exactly one valve for a fixed
     * duration, samples the shared flow sensor, and stores the average in
     * that valve's persistent `flowExpected` runtime state (never in native
     * config). Since there is only one shared sensor for the whole
     * installation, only one calibration can run at a time, and it is
     * rejected outright while any other valve is already running - a
     * reading taken while other valves are open cannot be attributed to the
     * valve being calibrated.
     *
     * The caller (main.ts) is responsible for actually opening/closing the
     * valve via automation/valve controller; this method only manages the
     * sampling window and result persistence.
     *
     * @param valveIndex
     * @param openValve
     * @param closeValve
     */
    public async startCalibration(
        valveIndex: number,
        openValve: () => Promise<void>,
        closeValve: () => Promise<void>,
    ): Promise<void> {
        if (this.calibratingValveIndex !== undefined) {
            this.deps.adapter.log.warn(
                `Calibration for valve ${valveIndex} rejected: valve ${this.calibratingValveIndex} is already being calibrated.`,
            );
            return;
        }
        if (this.deps.getRunningValveIndexes().length > 0) {
            this.deps.adapter.log.warn(
                `Calibration for valve ${valveIndex} rejected: another valve is currently running, so the shared flow sensor's reading could not be attributed to this valve alone.`,
            );
            return;
        }
        if (!this.subscribedId) {
            this.deps.adapter.log.warn(
                `Calibration for valve ${valveIndex} rejected: no flow sensor configured/enabled (flowMonitor.sensorId).`,
            );
            return;
        }

        this.calibratingValveIndex = valveIndex;
        this.calibrationSamples = [];

        try {
            await openValve();
        } catch (error) {
            // Roll back the optimistically-added calibration bookkeeping so this
            // valve's calibration state does not stay wedged forever with no timer
            // ever scheduled to clear it.
            this.calibratingValveIndex = undefined;
            this.calibrationSamples = [];
            this.deps.adapter.log.error(
                `Calibration for valve ${valveIndex} failed to open the valve: ${(error as Error).message}`,
            );
            return;
        }
        this.calibrationTimer = this.deps.adapter.setTimeout(() => {
            this.calibrationTimer = undefined;
            this.finishCalibration(valveIndex, closeValve).catch(error =>
                this.deps.adapter.log.error(`Calibration failed: ${(error as Error).message}`),
            );
        }, CALIBRATION_DURATION_SECS * 1000);
    }

    private async finishCalibration(valveIndex: number, closeValve: () => Promise<void>): Promise<void> {
        await closeValve();
        const samples = this.calibrationSamples;
        this.calibratingValveIndex = undefined;
        this.calibrationSamples = [];

        if (samples.length === 0) {
            this.deps.adapter.log.warn(`Calibration for valve ${valveIndex} yielded no samples.`);
            return;
        }
        const average = samples.reduce((sum, v) => sum + v, 0) / samples.length;
        await this.deps.adapter.setStateAsync(`valves.valve_${this.objectSuffixFor(valveIndex)}.flowExpected`, {
            val: Math.round(average * 100) / 100,
            ack: true,
        });
        this.deps.adapter.log.info(`Calibration for valve ${valveIndex} complete: ${average.toFixed(2)} l/min`);
    }

    /** Called on unload/onUnload to release any pending calibration timer. */
    public destroy(): void {
        if (this.calibrationTimer) {
            this.deps.adapter.clearTimeout(this.calibrationTimer);
            this.calibrationTimer = undefined;
        }
    }
}
