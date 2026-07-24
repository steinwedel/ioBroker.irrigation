/**
 * Shared TypeScript interfaces for the irrigation adapter.
 */

export type ValveType = 'Gardena' | 'Homematic' | 'Rainbird' | 'Hydrawise' | 'Generic';

/**
 * Formats a zero-based valve array index into its display/id suffix, e.g.
 * `formatValveNumber(0) === "000"`, `formatValveNumber(10) === "010"`.
 * Used both for the real ioBroker object id (`valves.valve_XXX`) and the
 * `valveNumber` display field in `native.valves[]`, so both always match and
 * sort correctly as plain strings (fixed-width, always 3 digits).
 *
 * @param index
 */
export function formatValveNumber(index: number): string {
    return String(index).padStart(3, '0');
}

/**
 * Converts the admin UI's `planValveTable` rows (as sent back by the
 * "Apply valve assignment" button) into the list of assigned valve indexes.
 *
 * Rows are matched back to real valve indexes via the unique, stable
 * `valveNumber` field (e.g. "007" -> 7) rather than the row's position in
 * the array. The admin UI's `table` component allows reordering/deleting
 * rows (sortable columns, move up/down, delete-row buttons), so after such
 * an interaction the row order no longer matches `this.config2.valves`
 * order - using the row index directly would silently assign the wrong
 * valves to the plan.
 *
 * @param rows
 * @param valveCount
 */
export function parsePlanValveTableOrder(rows: Array<{ valveNumber?: string }>, valveCount: number): number[] {
    const seen = new Set<number>();
    return rows
        .map(row => Number.parseInt(row.valveNumber ?? '', 10))
        .filter(index => {
            if (!Number.isInteger(index) || index < 0 || index >= valveCount || seen.has(index)) {
                return false;
            }
            seen.add(index);
            return true;
        });
}

export function parsePlanValveTableRows(
    rows: Array<{ valveNumber?: string; assigned?: boolean }>,
    valveCount: number,
): number[] {
    return parsePlanValveTableOrder(
        rows.filter(row => row?.assigned),
        valveCount,
    );
}

/**
 * Sentinel value used in `IPlanConfig.valveIndexes` to explicitly represent
 * "no valves assigned", as opposed to an empty array which means "all
 * valves" (see buildActiveValveList()). Real valve indices are always >= 0,
 * so this value never collides with an actual valve index and matching it
 * against `valveIndexes.includes(i)` for any real valve always fails.
 */
export const NONE_SENTINEL = -1;

/**
 * Auto-discovery scan types. "Generic" additionally scans any adapter not
 * covered by a specific type. "All" runs every scan type (Gardena, Rainbird,
 * Homematic, Hydrawise, Generic) in one go, without any adapter instance restriction.
 */
export type ScanType = ValveType | 'All';

export interface IValveConfig {
    name: string;
    type: ValveType;
    /** Meaning depends on `type`, see plan "stateId-Konvention pro Typ" */
    stateId: string;
    /** Only used for Gardena (stop_all_valves_i) and Rainbird (stopIrrigation) */
    allOffId?: string;
    /** Only an enabled valve can be started/stopped */
    enabled: boolean;
    /** Flow rate in liters per minute for water consumption calculation (0 = disabled) */
    flowRateLpm: number;
    /** Scheduled duration in minutes */
    duration: number;
    // --- expert fields (always present, neutral defaults when expert mode is off) ---
    rainIndependent: boolean;
    /** Percent, 0 = disabled */
    moistureThreshold: number;
    /** Manual single-valve run duration in minutes */
    manualDuration: number;
    /** Optional flow sensor state id (liters/min or pulses) */
    flowSensorId: string;
    /** 0=Sunday..6=Saturday, empty array = every day */
    days: number[];
}

export interface IPlanConfig {
    name: string;
    /**
     * Valve indexes to include in this plan. Empty array (the default "Alle"
     * plan) means "all valves" - see buildActiveValveList(). To express "no
     * valves" explicitly (e.g. "remove all valves from plan"), use
     * [NONE_SENTINEL] rather than [] to avoid the "all valves" fallback.
     */
    valveIndexes: number[];
    valveOrder?: number[];
}

export interface ISchedulerConfig {
    autoMode: boolean;
    /** "HH:MM" strings */
    timerTimes: string[];
    extensionFactor: number;
    temperatureAdjustmentEnabled: boolean;
    temperatureAdjustmentStateId: string;
    /** l/min, 0 = sequential only, >0 = parallel batch optimization */
    pumpCapacity: number;
    /** Minutes between batches/valves, 0 = disabled */
    valvePause: number;
    seasonEnabled: boolean;
    seasonStart: number;
    seasonEnd: number;
    frostEnabled: boolean;
    frostMinTemp: number;
    icalAdapterInstance: string;
    icalTriggerState: string;
    icalTitlePrefix: string;
}

export interface ISensorsConfig {
    rainId: string;
    soilMoistureId: string;
    temperatureId: string;
}

export interface IWeatherConfig {
    enabled: boolean;
    apiType: 'openweathermap';
    apiKey: string;
    latitude: number;
    longitude: number;
    pollInterval: number;
}

export interface ILegalRestrictionConfig {
    enabled: boolean;
    stationId: string;
    temperatureStateId: string;
    startDate: string;
    endDate: string;
    startTime: string;
    endTime: string;
    minTemperature: number;
    checkInterval: number;
}

export interface INotificationsConfig {
    pushoverInstance: string;
    telegramInstance: string;
}

export interface IWaterConsumptionConfig {
    enabled: boolean;
}

export interface IrrigationNativeConfig {
    expertMode: boolean;
    valves: IValveConfig[];
    plans: IPlanConfig[];
    scheduler: ISchedulerConfig;
    sensors: ISensorsConfig;
    weather: IWeatherConfig;
    legalRestriction: ILegalRestrictionConfig;
    notifications: INotificationsConfig;
    waterConsumption: IWaterConsumptionConfig;
}

/** Automation state machine status */
export type AutomationStatus = 'idle' | 'running' | 'paused';

/** What caused the automation to be paused/blocked, for status text + resume logic */
export type PauseReason = 'manual' | 'legalRestriction' | null;

/** A batch of valve indexes that run in parallel */
export type Batch = number[];

export interface IActiveValveRuntime {
    valveIndex: number;
    /** Effective duration in minutes for this run (already includes extensionFactor for automatic runs) */
    durationMinutes: number;
    startedAt: number;
}
