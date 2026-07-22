import type { IrrigationNativeConfig } from './types';

export interface DwdDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    onRestrictionChanged: (active: boolean) => Promise<void>;
}

const DWD_URL_BASE = 'https://opendata.dwd.de/weather/weather_reports/poi/';

function annualDayOfYear(month: number, day: number): number {
    return Math.floor((Date.UTC(2000, month - 1, day) - Date.UTC(2000, 0, 1)) / 86_400_000);
}

function parseAnnualDate(value: string): number | undefined {
    const match = /^([1-9]|[12]\d|3[01])\.([1-9]|1[0-2])$/.exec(value);
    if (!match) {
        return undefined;
    }
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day > new Date(2000, month, 0).getDate()) {
        return undefined;
    }
    return annualDayOfYear(month, day);
}

function parseTime(value: string): number | undefined {
    const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(value);
    if (!match) {
        return undefined;
    }
    return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Fetches the current temperature from the DWD POI CSV feed and evaluates
 * the "gesetzliche Beregnungssperre" rule. See plan section
 * "Beregnungssperre" and the reference BW Automatik.js implementation.
 */
export class DwdRestriction {
    private readonly deps: DwdDeps;
    private checkTimer: ReturnType<ioBroker.Adapter['setInterval']> | undefined;
    private active = false;

    public constructor(deps: DwdDeps) {
        this.deps = deps;
    }

    public isActive(): boolean {
        return this.active;
    }

    public async init(): Promise<void> {
        const config = this.deps.getConfig();
        await this.deps.adapter.setStateAsync('legalRestriction.enabled', {
            val: config.legalRestriction.enabled,
            ack: true,
        });
        if (!config.legalRestriction.enabled) {
            return;
        }

        const intervalMs = Math.max(1, config.legalRestriction.checkInterval) * 60 * 1000;
        this.checkTimer = this.deps.adapter.setInterval(() => {
            this.check().catch(error =>
                this.deps.adapter.log.error(`Legal restriction check failed: ${(error as Error).message}`),
            );
        }, intervalMs);
        await this.check();
    }

    public destroy(): void {
        if (this.checkTimer) {
            this.deps.adapter.clearInterval(this.checkTimer);
            this.checkTimer = undefined;
        }
    }

    private isWithinWindow(now: Date): boolean {
        const config = this.deps.getConfig().legalRestriction;
        const startDate = parseAnnualDate(config.startDate);
        const endDate = parseAnnualDate(config.endDate);
        const startTime = parseTime(config.startTime);
        const endTime = parseTime(config.endTime);
        if (startDate === undefined || endDate === undefined || startTime === undefined || endTime === undefined) {
            return false;
        }

        const currentDate = annualDayOfYear(now.getMonth() + 1, now.getDate());
        const current = currentDate * 24 * 60 + now.getHours() * 60 + now.getMinutes();
        const start = startDate * 24 * 60 + startTime;
        const end = endDate * 24 * 60 + endTime;
        return start <= end ? current >= start && current <= end : current >= start || current <= end;
    }

    public async check(): Promise<boolean> {
        const config = this.deps.getConfig();
        if (!config.legalRestriction.enabled) {
            await this.apply(false);
            return false;
        }

        if (!this.isWithinWindow(new Date())) {
            await this.apply(false);
            return false;
        }

        const temperatureStateId = config.legalRestriction.temperatureStateId.trim();
        if (temperatureStateId) {
            const temp = await this.fetchLocalTemperature(temperatureStateId);
            return this.applyTemperature(temp);
        }

        if (!config.legalRestriction.stationId.trim()) {
            await this.apply(true);
            return true;
        }

        const temp = await this.fetchTemperature(config.legalRestriction.stationId);
        return this.applyTemperature(temp);
    }

    public async onForeignStateChange(id: string, state: ioBroker.State | null | undefined): Promise<boolean> {
        const config = this.deps.getConfig();
        if (id !== config.legalRestriction.temperatureStateId.trim()) {
            return false;
        }
        if (!config.legalRestriction.enabled || !this.isWithinWindow(new Date())) {
            await this.apply(false);
            return true;
        }
        const temp = typeof state?.val === 'number' && Number.isFinite(state.val) ? state.val : null;
        if (temp === null) {
            await this.recordTemperatureError('Local temperature state has no valid numeric value');
            return true;
        }
        await this.recordTemperature(temp);
        await this.apply(temp >= config.legalRestriction.minTemperature);
        return true;
    }

    private async applyTemperature(temp: number | null): Promise<boolean> {
        if (temp === null) {
            return this.active;
        }
        const restricted = temp >= this.deps.getConfig().legalRestriction.minTemperature;
        await this.apply(restricted);
        return restricted;
    }

    private async apply(restricted: boolean): Promise<void> {
        const wasActive = this.active;
        this.active = restricted;
        await this.deps.adapter.setStateAsync('legalRestriction.active', { val: restricted, ack: true });
        if (restricted !== wasActive) {
            await this.deps.onRestrictionChanged(restricted);
        }
    }

    private async fetchLocalTemperature(stateId: string): Promise<number | null> {
        try {
            const state = await this.deps.adapter.getForeignStateAsync(stateId);
            const temp = typeof state?.val === 'number' && Number.isFinite(state.val) ? state.val : null;
            if (temp === null) {
                throw new Error('Local temperature state has no valid numeric value');
            }
            await this.recordTemperature(temp);
            return temp;
        } catch (error) {
            const message = (error as Error).message;
            this.deps.adapter.log.warn(`Local temperature read failed: ${message}`);
            await this.recordTemperatureError(message);
            return null;
        }
    }

    private async fetchTemperature(stationId: string): Promise<number | null> {
        try {
            const response = await fetch(`${DWD_URL_BASE}${stationId}-BEOB.csv`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const csv = await response.text();
            const temp = parseDwdTemperature(csv);
            if (temp === null) {
                throw new Error('Temperature column not found or unparsable in DWD CSV');
            }
            await this.recordTemperature(temp);
            return temp;
        } catch (error) {
            const message = (error as Error).message;
            this.deps.adapter.log.warn(`DWD temperature fetch failed: ${message}`);
            await this.recordTemperatureError(message);
            return null;
        }
    }

    private async recordTemperature(temp: number): Promise<void> {
        await this.deps.adapter.setStateAsync('legalRestriction.currentTemp', { val: temp, ack: true });
        await this.deps.adapter.setStateAsync('legalRestriction.currentTempTs', { val: Date.now(), ack: true });
        await this.deps.adapter.setStateAsync('legalRestriction.lastCheckError', { val: '', ack: true });
    }

    private async recordTemperatureError(message: string): Promise<void> {
        await this.deps.adapter.setStateAsync('legalRestriction.lastCheckError', { val: message, ack: true });
    }
}

/**
 * Parses the DWD POI CSV format (see BW Automatik.js parseDwdTemperature).
 *
 * @param csv
 */
export function parseDwdTemperature(csv: string): number | null {
    if (!csv) {
        return null;
    }
    const lines = csv.split('\n');
    if (lines.length < 4) {
        return null;
    }

    const headerCols = lines[2].trim().split(';');
    const tempColumnIndex = headerCols.indexOf('Temperatur (2m)');
    if (tempColumnIndex === -1) {
        return null;
    }

    const dataLine = lines[3].trim();
    if (!dataLine) {
        return null;
    }

    const cols = dataLine.split(';');
    if (cols.length <= tempColumnIndex) {
        return null;
    }

    const raw = cols[tempColumnIndex].trim().replace(',', '.');
    if (raw === '' || raw === '---') {
        return null;
    }

    const temp = parseFloat(raw);
    return isNaN(temp) ? null : temp;
}
