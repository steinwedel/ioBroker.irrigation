import type { IrrigationNativeConfig } from './types';

export interface DwdDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    onRestrictionChanged: (active: boolean) => Promise<void>;
}

const DWD_URL_BASE = 'https://opendata.dwd.de/weather/weather_reports/poi/';

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
        const month = now.getMonth() + 1;
        const hour = now.getHours();
        if (month < config.monthStart || month > config.monthEnd) {
            return false;
        }
        if (hour < config.hourStart || hour >= config.hourEnd) {
            return false;
        }
        return true;
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

        if (!config.legalRestriction.stationId.trim()) {
            await this.apply(true);
            return true;
        }

        const temp = await this.fetchTemperature(config.legalRestriction.stationId);
        if (temp === null) {
            // keep previous state on fetch failure, see plan risk "DWD-API"
            return this.active;
        }

        const restricted = temp >= config.legalRestriction.minTemperature;
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
            await this.deps.adapter.setStateAsync('legalRestriction.currentTemp', { val: temp, ack: true });
            await this.deps.adapter.setStateAsync('legalRestriction.currentTempTs', { val: Date.now(), ack: true });
            await this.deps.adapter.setStateAsync('legalRestriction.lastCheckError', { val: '', ack: true });
            return temp;
        } catch (error) {
            const message = (error as Error).message;
            this.deps.adapter.log.warn(`DWD temperature fetch failed: ${message}`);
            await this.deps.adapter.setStateAsync('legalRestriction.lastCheckError', { val: message, ack: true });
            return null;
        }
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
