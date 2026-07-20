import { formatValveNumber, type IrrigationNativeConfig } from './types';

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
        if (!this.deps.getConfig().waterConsumption.enabled) {
            return;
        }
        if (flowing) {
            this.valveStartedAt.set(valveIndex, Date.now());
        } else {
            const startedAt = this.valveStartedAt.get(valveIndex);
            if (startedAt === undefined) {
                return;
            }
            this.valveStartedAt.delete(valveIndex);
            const elapsedMin = (Date.now() - startedAt) / 60000;
            const config = this.deps.getConfig();
            const valve = config.valves[valveIndex];
            const liters = elapsedMin * (valve?.flowRateLpm ?? 0);
            this.recordConsumption(valveIndex, liters).catch(error =>
                this.deps.adapter.log.error(`Failed to record water consumption: ${(error as Error).message}`),
            );
        }
    }

    private async recordConsumption(valveIndex: number, liters: number): Promise<void> {
        this.rolloverIfNeeded();

        this.dayTotal += liters;
        this.weekTotal += liters;
        this.monthTotal += liters;
        this.grandTotal += liters;

        await this.deps.adapter.setStateAsync('waterConsumption.today', { val: round2(this.dayTotal), ack: true });
        await this.deps.adapter.setStateAsync('waterConsumption.week', { val: round2(this.weekTotal), ack: true });
        await this.deps.adapter.setStateAsync('waterConsumption.month', { val: round2(this.monthTotal), ack: true });
        await this.deps.adapter.setStateAsync('waterConsumption.total', { val: round2(this.grandTotal), ack: true });

        const valveId = `valves.valve_${formatValveNumber(valveIndex)}`;
        const currentTotal = await this.deps.adapter.getStateAsync(`${valveId}.waterTotal`);
        const newTotal = (typeof currentTotal?.val === 'number' ? currentTotal.val : 0) + liters;
        await this.deps.adapter.setStateAsync(`${valveId}.waterCurrent`, { val: round2(liters), ack: true });
        await this.deps.adapter.setStateAsync(`${valveId}.waterTotal`, { val: round2(newTotal), ack: true });
    }

    private rolloverIfNeeded(): void {
        const nowDay = new Date().getDate();
        if (nowDay !== this.currentDay) {
            this.dayTotal = 0;
            this.currentDay = nowDay;
        }
        // week/month rollover intentionally simplified: reset on day 1 for month,
        // and Monday for week. Kept minimal for v1 as per plan scope.
        const now = new Date();
        if (now.getDay() === 1) {
            this.weekTotal = 0;
        }
        if (now.getDate() === 1) {
            this.monthTotal = 0;
        }
    }
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
