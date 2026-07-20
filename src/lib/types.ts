/**
 * Shared TypeScript interfaces for the irrigation adapter.
 * Mirrors the `native` configuration structure documented in
 * plans/irrigation-adapter-plan.md.
 */

export type ValveType = 'Gardena' | 'Homematic' | 'Rainbird' | 'Generic';

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
 * Auto-discovery scan types. "Generic" additionally scans any adapter not
 * covered by a specific type. "All" runs every scan type (Gardena, Rainbird,
 * Homematic, Generic) in one go, without any adapter instance restriction.
 */
export type ScanType = ValveType | 'All';

export interface IValveConfig {
    name: string;
    type: ValveType;
    /** Meaning depends on `type`, see plan "stateId-Konvention pro Typ" */
    stateId: string;
    /** Only used for Gardena (stop_all_valves_i) and Rainbird (stopIrrigation) */
    allOffId?: string;
    /** Duration in seconds used when this valve is started manually via the "state" mirror state */
    runFor: number;
}

export interface IZoneConfig {
    name: string;
    /** Index into native.valves[] */
    valveIndex: number;
    /** Scheduled duration in minutes */
    duration: number;
    enabled: boolean;
    // --- expert fields (always present, neutral defaults when expert mode is off) ---
    rainIndependent: boolean;
    /** Percent, 0 = disabled */
    moistureThreshold: number;
    /** Manual single-zone run duration in minutes */
    manualDuration: number;
    /** Optional flow sensor state id (liters/min or pulses) */
    flowSensorId: string;
    /** l/min, used for calculated water consumption */
    flowRate: number;
    groups: string[];
    /** 0=Sunday..6=Saturday, empty array = every day */
    days: number[];
}

export interface IPlanConfig {
    name: string;
    /** Zone groups to include. Empty = all zones (used by built-in "Alle" plan) */
    groups: string[];
}

export interface ISchedulerConfig {
    autoMode: boolean;
    /** "HH:MM" strings */
    timerTimes: string[];
    extensionFactor: number;
    /** l/min, 0 = sequential only, >0 = parallel batch optimization */
    pumpCapacity: number;
    /** Minutes between batches/zones, 0 = disabled */
    zonePause: number;
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
    monthStart: number;
    monthEnd: number;
    hourStart: number;
    hourEnd: number;
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
    zones: IZoneConfig[];
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

/** A batch of zone indexes that run in parallel */
export type Batch = number[];

export interface IActiveZoneRuntime {
    zoneIndex: number;
    valveIndex: number;
    /** Effective duration in minutes for this run (already includes extensionFactor for automatic runs) */
    durationMinutes: number;
    startedAt: number;
}
