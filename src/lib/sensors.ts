import type { IrrigationNativeConfig } from './types';

export interface SensorsDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
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
    private subscribedIds: string[] = [];

    public constructor(deps: SensorsDeps) {
        this.deps = deps;
    }

    public async init(): Promise<void> {
        await this.resubscribe();
    }

    public async resubscribe(): Promise<void> {
        for (const id of this.subscribedIds) {
            await this.deps.adapter.unsubscribeForeignStatesAsync(id);
        }
        this.subscribedIds = [];

        const config = this.deps.getConfig();
        const stateIds = new Set([
            config.sensors.rainId,
            config.sensors.soilMoistureId,
            config.sensors.temperatureId,
            config.legalRestriction.temperatureStateId,
        ]);
        for (const id of stateIds) {
            if (id) {
                await this.deps.adapter.subscribeForeignStatesAsync(id);
                this.subscribedIds.push(id);
            }
        }
    }

    public async onForeignStateChange(id: string, state: ioBroker.State | null | undefined): Promise<boolean> {
        const config = this.deps.getConfig();
        if (id === config.sensors.rainId) {
            this.rainState = state?.val === true;
            await this.deps.adapter.setStateAsync('sensors.rain', { val: this.rainState, ack: true });
            return true;
        }
        if (id === config.sensors.soilMoistureId) {
            this.soilMoistureState = typeof state?.val === 'number' ? state.val : 0;
            await this.deps.adapter.setStateAsync('sensors.soilMoisture', { val: this.soilMoistureState, ack: true });
            return true;
        }
        if (id === config.sensors.temperatureId) {
            this.temperatureState = typeof state?.val === 'number' ? state.val : 0;
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
        if (
            config.sensors.soilMoistureId &&
            valve.moistureThreshold > 0 &&
            this.soilMoistureState >= valve.moistureThreshold
        ) {
            return {
                blocked: true,
                reason: `soil moisture ${this.soilMoistureState}% >= threshold ${valve.moistureThreshold}%`,
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
