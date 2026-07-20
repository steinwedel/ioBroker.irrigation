import type { IZoneConfig } from './types';

/**
 * Creates/updates the ioBroker objects for a single zone, per the plan's
 * "Objekt-Hierarchie" zones.zone_N branch.
 */
export class ZoneController {
    private readonly adapter: ioBroker.Adapter;
    private readonly index: number;
    private config: IZoneConfig;

    public constructor(adapter: ioBroker.Adapter, index: number, config: IZoneConfig) {
        this.adapter = adapter;
        this.index = index;
        this.config = config;
    }

    public get id(): string {
        return `zones.zone_${this.index}`;
    }

    public getConfig(): IZoneConfig {
        return this.config;
    }

    public async init(): Promise<void> {
        await this.adapter.setObjectNotExistsAsync(this.id, {
            type: 'channel',
            common: { name: this.config.name },
            native: {},
        });

        await this.ensureState('name', 'string', 'text', true, this.config.name);
        await this.ensureState('valveId', 'string', 'text', true, String(this.config.valveIndex));
        await this.ensureState('duration', 'number', 'level.timer', true, this.config.duration, 'min');
        await this.ensureState('enabled', 'boolean', 'switch', true, this.config.enabled);
        await this.ensureState('rainIndependent', 'boolean', 'switch', true, this.config.rainIndependent);
        await this.ensureState('moistureThreshold', 'number', 'value', true, this.config.moistureThreshold, '%');
        await this.ensureState('manualStart', 'boolean', 'button', true, false);
        await this.ensureState('manualDuration', 'number', 'level.timer', true, this.config.manualDuration, 'min');
        await this.ensureState('flowSensorId', 'string', 'text', true, this.config.flowSensorId);
        // flowExpected is intentionally a runtime-only state (populated via calibration),
        // never overwritten from native config - see plan "Durchfluss-Kalibrierung"
        await this.adapter.setObjectNotExistsAsync(`${this.id}.flowExpected`, {
            type: 'state',
            common: {
                name: 'Expected flow rate (calibrated)',
                type: 'number',
                role: 'value',
                unit: 'l/min',
                read: true,
                write: true,
                def: 0,
            },
            native: {},
        });
        await this.ensureState('flowActual', 'number', 'value', false, 0, 'l/min');
        await this.ensureState('calibrateFlow', 'boolean', 'button', true, false);
        await this.ensureState('groups', 'string', 'json', true, JSON.stringify(this.config.groups));
        await this.ensureState('days', 'string', 'list', true, JSON.stringify(this.config.days));
        await this.ensureState('flowRate', 'number', 'value', true, this.config.flowRate, 'l/min');
        await this.ensureState('waterCurrent', 'number', 'value.fill', false, 0, 'l');
        await this.ensureState('waterTotal', 'number', 'value.fill', false, 0, 'l');
    }

    private async ensureState(
        name: string,
        type: ioBroker.CommonType,
        role: string,
        write: boolean,
        def: string | number | boolean,
        unit?: string,
    ): Promise<void> {
        await this.adapter.setObjectNotExistsAsync(`${this.id}.${name}`, {
            type: 'state',
            common: {
                name,
                type,
                role,
                unit,
                read: true,
                write,
                def,
            },
            native: {},
        });
    }
}
