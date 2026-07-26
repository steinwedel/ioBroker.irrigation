import type { IrrigationNativeConfig } from './types';

export interface WaterConsumptionDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
}

/**
 * Tracks calculated (flowRate x runtime) and optionally sensor-based actual
 * water consumption per valve and in aggregate. See plan section
 * "Wasserverbrauch" and "Durchfluss-Überwachung"/"Durchfluss-Kalibrierung".
 */
export class WaterConsumptionTracker {
    private readonly deps: WaterConsumptionDeps;
    private valveStartedAt = new Map<number, number>();
    private dayTotal = 0;
    private weekTotal = 0;
    private monthTotal = 0;
    private grandTotal = 0;
    private currentDay = new Date().getDate();
    private currentWeekKey = weekKeyOf(new Date());
    private currentMonthKey = monthKeyOf(new Date());
    /**
     * Serializes all state writes done by recordConsumption() so that
     * concurrent calls for different valves can never interleave their
     * setStateAsync() writes and persist a stale/too-low value. See
     * ventile.ts's `commandChain` for the same pattern.
     */
    private writeChain: Promise<void> = Promise.resolve();

    public constructor(deps: WaterConsumptionDeps) {
        this.deps = deps;
    }

    public async init(): Promise<void> {
        const config = this.deps.getConfig();
        await this.deps.adapter.setStateAsync('waterConsumption.enabled', {
            val: config.waterConsumption.enabled,
            ack: true,
        });
        const today = await this.deps.adapter.getStateAsync('waterConsumption.today');
        const week = await this.deps.adapter.getStateAsync('waterConsumption.week');
        const month = await this.deps.adapter.getStateAsync('waterConsumption.month');
        const total = await this.deps.adapter.getStateAsync('waterConsumption.total');
        this.dayTotal = typeof today?.val === 'number' ? today.val : 0;
        this.weekTotal = typeof week?.val === 'number' ? week.val : 0;
        this.monthTotal = typeof month?.val === 'number' ? month.val : 0;
        this.grandTotal = typeof total?.val === 'number' ? total.val : 0;
    }

    /**
     * Called by automation.ts when a valve opens/closes.
     *
     * @param valveIndex
     * @param flowing
     */
    public onValveFlowChange(valveIndex: number, flowing: boolean): void {
        if (flowing) {
            if (!this.deps.getConfig().waterConsumption.enabled) {
                return;
            }
            this.valveStartedAt.set(valveIndex, Date.now());
        } else {
            const startedAt = this.valveStartedAt.get(valveIndex);
            // Always delete, regardless of the enabled flag or whether a start
            // timestamp exists, so that toggling "enabled" off mid-run (or a
            // missing start timestamp) never leaks an entry in this map.
            this.valveStartedAt.delete(valveIndex);
            if (startedAt === undefined) {
                this.deps.adapter.log.warn(
                    `Water consumption for valve ${valveIndex} could not be calculated: start time unknown, likely due to adapter restart during valve run.`,
                );
                return;
            }
            if (!this.deps.getConfig().waterConsumption.enabled) {
                return;
            }
            const elapsedMin = Math.max(0, (Date.now() - startedAt) / 60000);
            const config = this.deps.getConfig();
            const valve = config.valves[valveIndex];
            const liters = elapsedMin * (valve?.flowRateLpm ?? 0);
            this.recordConsumption(valveIndex, liters).catch(error =>
                this.deps.adapter.log.error(`Failed to record water consumption: ${(error as Error).message}`),
            );
        }
    }

    private async recordConsumption(valveIndex: number, liters: number): Promise<void> {
        // Chain onto writeChain rather than writing state directly, so that
        // concurrent recordConsumption() calls for different valves never
        // interleave their setStateAsync() writes (which would otherwise risk
        // persisting a stale/too-low total). See ventile.ts's `commandChain`
        // field comment for the same pattern and rationale for the .catch().
        this.writeChain = this.writeChain
            .then(() => this.doRecordConsumption(valveIndex, liters))
            .catch(error => {
                this.deps.adapter.log.error(
                    `Failed to record water consumption for valve ${valveIndex}: ${(error as Error).message}`,
                );
            });
        await this.writeChain;
    }

    private async doRecordConsumption(valveIndex: number, liters: number): Promise<void> {
        this.rolloverIfNeeded();

        this.dayTotal += liters;
        this.weekTotal += liters;
        this.monthTotal += liters;
        this.grandTotal += liters;

        await this.deps.adapter.setStateAsync('waterConsumption.today', { val: round2(this.dayTotal), ack: true });
        await this.deps.adapter.setStateAsync('waterConsumption.week', { val: round2(this.weekTotal), ack: true });
        await this.deps.adapter.setStateAsync('waterConsumption.month', { val: round2(this.monthTotal), ack: true });
        await this.deps.adapter.setStateAsync('waterConsumption.total', { val: round2(this.grandTotal), ack: true });
    }

    private rolloverIfNeeded(): void {
        const now = new Date();
        const nowDay = now.getDate();
        if (nowDay !== this.currentDay) {
            this.dayTotal = 0;
            this.currentDay = nowDay;
        }
        // week/month rollover intentionally simplified: reset on the first Monday
        // seen for the week, and on the first day of a new month. Both are guarded
        // by a key comparison (rather than "getDay() === 1"/"getDate() === 1" alone)
        // so that repeated calls on the same Monday/1st-of-month do not wipe out
        // consumption already recorded earlier that same day.
        const weekKey = weekKeyOf(now);
        if (weekKey !== this.currentWeekKey) {
            this.weekTotal = 0;
            this.currentWeekKey = weekKey;
        }
        const monthKey = monthKeyOf(now);
        if (monthKey !== this.currentMonthKey) {
            this.monthTotal = 0;
            this.currentMonthKey = monthKey;
        }
    }
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * ISO-8601-ish week key ("<year>-W<week>") used to detect the Monday-to-Monday
 * boundary exactly once, instead of re-triggering the reset on every call made
 * on a Monday.
 *
 * @param date
 */
function weekKeyOf(date: Date): string {
    // Shift to the Monday of the current week, then key by that Monday's date.
    const monday = new Date(date);
    const isoDayOfWeek = (date.getDay() + 6) % 7; // Monday=0 ... Sunday=6
    monday.setDate(date.getDate() - isoDayOfWeek);
    return `${monday.getFullYear()}-${monday.getMonth()}-${monday.getDate()}`;
}

/**
 * Month key ("<year>-<month>") used to detect the month boundary exactly
 * once, instead of re-triggering the reset on every call made on the 1st.
 *
 * @param date
 */
function monthKeyOf(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth()}`;
}
