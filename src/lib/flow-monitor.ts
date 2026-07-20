import { formatValveNumber, type IrrigationNativeConfig } from './types';
import type { NotificationManager } from './notifications';

export interface FlowMonitorDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    notifications: NotificationManager;
    /** True while any valve is actively running (automatic or manual) */
    isAnyValveRunning: () => boolean;
}

const DEVIATION_THRESHOLD_PCT = 30;
const CALIBRATION_DURATION_SECS = 120;

/**
 * Subscribes to per-valve flow sensor states, tracks actual vs. expected flow
 * for leak/clog detection, and implements the calibration routine.
 * See plan behavior rules "Durchfluss-Überwachung" and "Durchfluss-Kalibrierung".
 */
export class FlowMonitor {
    private readonly deps: FlowMonitorDeps;
    private subscribedIds = new Map<string, number>(); // stateId -> valveIndex
    private calibrationSamples = new Map<number, number[]>();
    private calibrationActive = new Set<number>();
    private calibrationTimers = new Map<number, ReturnType<ioBroker.Adapter['setTimeout']>>();

    public constructor(deps: FlowMonitorDeps) {
        this.deps = deps;
    }

    public async init(): Promise<void> {
        await this.resubscribe();
    }

    public async resubscribe(): Promise<void> {
        for (const id of this.subscribedIds.keys()) {
            await this.deps.adapter.unsubscribeForeignStatesAsync(id);
        }
        this.subscribedIds.clear();

        const config = this.deps.getConfig();
        for (let i = 0; i < config.valves.length; i++) {
            const id = config.valves[i].flowSensorId;
            if (id) {
                await this.deps.adapter.subscribeForeignStatesAsync(id);
                this.subscribedIds.set(id, i);
            }
        }
    }

    public async onForeignStateChange(id: string, state: ioBroker.State | null | undefined): Promise<boolean> {
        const valveIndex = this.subscribedIds.get(id);
        if (valveIndex === undefined) {
            return false;
        }

        const flow = typeof state?.val === 'number' ? state.val : 0;
        await this.deps.adapter.setStateAsync(`valves.valve_${formatValveNumber(valveIndex)}.flowActual`, {
            val: flow,
            ack: true,
        });

        if (this.calibrationActive.has(valveIndex)) {
            const samples = this.calibrationSamples.get(valveIndex) ?? [];
            samples.push(flow);
            this.calibrationSamples.set(valveIndex, samples);
        } else {
            await this.checkDeviation(valveIndex, flow);
        }

        // leak detection: any flow while nothing is running
        if (!this.deps.isAnyValveRunning() && flow > 0) {
            await this.reportLeak(valveIndex, flow);
        }

        return true;
    }

    private async checkDeviation(valveIndex: number, actualFlow: number): Promise<void> {
        const expected = await this.getExpectedFlow(valveIndex);
        if (!expected || expected <= 0) {
            return;
        }

        const deviationPct = ((actualFlow - expected) / expected) * 100;
        if (Math.abs(deviationPct) > DEVIATION_THRESHOLD_PCT) {
            const config = this.deps.getConfig();
            const valveName = config.valves[valveIndex]?.name ?? String(valveIndex);
            const message =
                deviationPct > 0
                    ? `Valve "${valveName}": Durchfluss ${Math.round(deviationPct)}% über Erwartung (Rohrbruch?)`
                    : `Valve "${valveName}": Durchfluss ${Math.round(Math.abs(deviationPct))}% unter Erwartung (Düsen verstopft?)`;

            await this.deps.adapter.setStateAsync('watchdog.flowDeviationValve', { val: valveIndex, ack: true });
            await this.deps.adapter.setStateAsync('watchdog.flowDeviationPct', {
                val: Math.round(deviationPct),
                ack: true,
            });
            await this.reportIssue(message);
        }
    }

    private async reportLeak(valveIndex: number, flow: number): Promise<void> {
        await this.deps.adapter.setStateAsync('watchdog.flowActive', { val: true, ack: true });
        const config = this.deps.getConfig();
        const valveName = config.valves[valveIndex]?.name ?? String(valveIndex);
        await this.reportIssue(
            `Leck-Verdacht: Durchfluss ${flow}l/min an Sensor des Ventils "${valveName}", obwohl alle Ventile geschlossen sind.`,
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

    private async getExpectedFlow(valveIndex: number): Promise<number> {
        const state = await this.deps.adapter.getStateAsync(
            `valves.valve_${formatValveNumber(valveIndex)}.flowExpected`,
        );
        return typeof state?.val === 'number' ? state.val : 0;
    }

    /**
     * Runs the calibration routine: opens the valve for a fixed
     * duration, samples the flow sensor, and stores the average in the
     * persistent `flowExpected` runtime state (never in native config).
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
        if (this.calibrationActive.has(valveIndex)) {
            return;
        }
        this.calibrationActive.add(valveIndex);
        this.calibrationSamples.set(valveIndex, []);

        await openValve();
        const timer = this.deps.adapter.setTimeout(() => {
            this.calibrationTimers.delete(valveIndex);
            this.finishCalibration(valveIndex, closeValve).catch(error =>
                this.deps.adapter.log.error(`Calibration failed: ${(error as Error).message}`),
            );
        }, CALIBRATION_DURATION_SECS * 1000);
        this.calibrationTimers.set(valveIndex, timer);
    }

    private async finishCalibration(valveIndex: number, closeValve: () => Promise<void>): Promise<void> {
        await closeValve();
        const samples = this.calibrationSamples.get(valveIndex) ?? [];
        this.calibrationActive.delete(valveIndex);
        this.calibrationSamples.delete(valveIndex);

        if (samples.length === 0) {
            this.deps.adapter.log.warn(`Calibration for valve ${valveIndex} yielded no samples.`);
            return;
        }
        const average = samples.reduce((sum, v) => sum + v, 0) / samples.length;
        await this.deps.adapter.setStateAsync(`valves.valve_${formatValveNumber(valveIndex)}.flowExpected`, {
            val: Math.round(average * 100) / 100,
            ack: true,
        });
        this.deps.adapter.log.info(`Calibration for valve ${valveIndex} complete: ${average.toFixed(2)} l/min`);
    }

    /** Called on unload/onUnload to release any pending calibration timers. */
    public destroy(): void {
        for (const timer of this.calibrationTimers.values()) {
            this.deps.adapter.clearTimeout(timer);
        }
        this.calibrationTimers.clear();
    }
}
