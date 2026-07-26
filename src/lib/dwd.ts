import type { IrrigationNativeConfig } from './types';

export interface DwdDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    onRestrictionChanged: (active: boolean) => Promise<void>;
}

const DWD_URL_BASE = 'https://opendata.dwd.de/weather/weather_reports/poi/';
const FETCH_TIMEOUT_MS = 15_000;
/** Consider the last successful temperature reading stale after this many checks worth of time. */
const MAX_TEMP_AGE_CHECK_MULTIPLIER = 3;
/** Hard fallback max-age if checkInterval can't be trusted (e.g. NaN/undefined). */
const DEFAULT_MAX_TEMP_AGE_MS = 6 * 60 * 60 * 1000;

function annualDayOfYear(month: number, day: number): number {
    return Math.floor((Date.UTC(2000, month - 1, day) - Date.UTC(2000, 0, 1)) / 86_400_000);
}

function parseAnnualDate(value: string): number | undefined {
    const match = /^(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])$/.exec(value);
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

        const checkIntervalMinutes = Number.isFinite(config.legalRestriction.checkInterval)
            ? config.legalRestriction.checkInterval
            : 10;
        const intervalMs = Math.max(1, checkIntervalMinutes) * 60 * 1000;
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
        const hasDateRange = Boolean(config.startDate || config.endDate);
        const hasTimeRange = Boolean(config.startTime || config.endTime);
        const startDate = parseAnnualDate(config.startDate);
        const endDate = parseAnnualDate(config.endDate);
        const startTime = parseTime(config.startTime);
        const endTime = parseTime(config.endTime);
        if (hasDateRange && (startDate === undefined || endDate === undefined)) {
            this.deps.adapter.log.error(
                `Legal restriction date range is invalid (startDate="${config.startDate}", endDate="${config.endDate}"); expected format D.M, e.g. "1.6" or "01.06". Restriction cannot be evaluated.`,
            );
            return false;
        }
        if (hasTimeRange && (startTime === undefined || endTime === undefined)) {
            this.deps.adapter.log.error(
                `Legal restriction time range is invalid (startTime="${config.startTime}", endTime="${config.endTime}"); expected format HH:MM. Restriction cannot be evaluated.`,
            );
            return false;
        }

        const currentDate = annualDayOfYear(now.getMonth() + 1, now.getDate());
        const currentTime = now.getHours() * 60 + now.getMinutes();
        const isWithinDateRange =
            !hasDateRange ||
            (startDate! <= endDate!
                ? currentDate >= startDate! && currentDate <= endDate!
                : currentDate >= startDate! || currentDate <= endDate!);
        const isWithinTimeRange =
            !hasTimeRange ||
            (startTime! <= endTime!
                ? currentTime >= startTime! && currentTime <= endTime!
                : currentTime >= startTime! || currentTime <= endTime!);
        return isWithinDateRange && isWithinTimeRange;
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const response = await fetch(`${DWD_URL_BASE}${stationId}-BEOB.csv`, { signal: controller.signal });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const csv = await response.text();
            const temp = parseDwdTemperature(csv);
            if (temp === null) {
                throw new Error('Temperature column not found or unparsable in DWD CSV');
            }
            await this.recordTemperature(temp);
            await this.deps.adapter.setStateAsync('info.connection', { val: true, ack: true });
            return temp;
        } catch (error) {
            const isAbort = (error as { name?: string }).name === 'AbortError';
            const message = isAbort ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s` : (error as Error).message;
            this.deps.adapter.log.warn(`DWD temperature fetch failed: ${message}`);
            await this.recordTemperatureError(message);
            await this.deps.adapter.setStateAsync('info.connection', { val: false, ack: true });
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    private getMaxTempAgeMs(): number {
        const config = this.deps.getConfig().legalRestriction;
        if (!Number.isFinite(config.checkInterval) || config.checkInterval <= 0) {
            return DEFAULT_MAX_TEMP_AGE_MS;
        }
        return config.checkInterval * 60 * 1000 * MAX_TEMP_AGE_CHECK_MULTIPLIER;
    }

    private async checkTemperatureAge(): Promise<void> {
        const state = await this.deps.adapter.getStateAsync?.('legalRestriction.currentTempTs');
        const ts = typeof state?.val === 'number' ? state.val : undefined;
        if (ts === undefined) {
            return;
        }
        const maxAgeMs = this.getMaxTempAgeMs();
        const ageMs = Date.now() - ts;
        if (ageMs > maxAgeMs) {
            this.deps.adapter.log.warn(
                `Legal restriction: last successful temperature reading is ${Math.round(ageMs / 60_000)} minutes old (threshold ${Math.round(maxAgeMs / 60_000)} minutes). Restriction decisions may be based on stale data.`,
            );
        }
    }

    private async recordTemperature(temp: number): Promise<void> {
        await this.deps.adapter.setStateAsync('legalRestriction.currentTemp', { val: temp, ack: true });
        await this.deps.adapter.setStateAsync('legalRestriction.currentTempTs', { val: Date.now(), ack: true });
        await this.deps.adapter.setStateAsync('legalRestriction.lastCheckError', { val: '', ack: true });
    }

    private async recordTemperatureError(message: string): Promise<void> {
        await this.deps.adapter.setStateAsync('legalRestriction.lastCheckError', { val: message, ack: true });
        await this.checkTemperatureAge();
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
