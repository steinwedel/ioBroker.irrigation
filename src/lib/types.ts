/**
 * Shared TypeScript interfaces for the irrigation adapter.
 */

export type ValveType = 'Gardena' | 'Homematic' | 'Rainbird' | 'Hydrawise' | 'Generic';

/**
 * Formats a numeric id into its display/object-id suffix, e.g.
 * `formatValveNumber(0) === "000"`, `formatValveNumber(10) === "010"`.
 * Used both for the real ioBroker object id (`valves.valve_XXX`) and the
 * `valveNumber` display field in `native.valves[]`, so both always match and
 * sort correctly as plain strings (fixed-width, always 3 digits).
 *
 * Historically this was called with the valve's array index, which made the
 * real ioBroker object id (and thus all state history) change whenever a
 * valve was reordered in the admin table. It is now called with the valve's
 * stable, never-reused `id` field instead (see `IValveConfig.id`), so moving
 * a valve up/down no longer changes its object id.
 *
 * @param id
 */
export function formatValveNumber(id: number): string {
    return String(id).padStart(3, '0');
}

/**
 * Converts the admin UI's `planValveTable` rows (as sent back by the
 * "Apply valve assignment" button) into the list of assigned valve indexes
 * (positions in `valves`, in its current/current-array order).
 *
 * Rows are matched back to valves via the unique, stable `valveNumber`
 * field, which mirrors each valve's stable `id` (not its array position) -
 * see `formatValveNumber()`. The admin UI's `table` component allows
 * reordering/deleting rows (sortable columns, move up/down, delete-row
 * buttons), so after such an interaction the row order no longer matches
 * `valves`' order, and a valve's array index can differ from the id encoded
 * in `valveNumber` - using either the row index or the raw parsed number as
 * an index directly would silently assign the wrong valves to the plan.
 *
 * @param rows
 * @param valves
 */
export function parsePlanValveTableRows(
    rows: Array<{ valveNumber?: string; assigned?: boolean }>,
    valves: Array<{ id?: number }>,
): number[] {
    return rows
        .filter(row => row?.assigned)
        .map(row => Number.parseInt(row.valveNumber ?? '', 10))
        .filter(id => Number.isInteger(id))
        .map(id => valves.findIndex(valve => valve.id === id))
        .filter(index => index >= 0);
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
 * Reconciles a plan's stable-ID valve assignment against the current list of
 * valve state IDs (in Valves-tab order). Handles:
 * - Newly added valves: automatically included unless the plan was
 *   explicitly emptied (valveIndexes === [NONE_SENTINEL]).
 * - Removed valves: dropped from the assignment.
 * - Renamed/reordered valves: unaffected, since matching is by stateId, not
 *   by name or array index.
 *
 * @param plan
 * @param currentStateIds
 */
export function synchronizePlanWithValves(plan: IPlanConfig, currentStateIds: string[]): IPlanConfig {
    const explicitlyEmpty = plan.valveIndexes.includes(NONE_SENTINEL);
    const legacySelectedStateIds = plan.valveIndexes
        .map(index => currentStateIds[index])
        .filter((stateId): stateId is string => Boolean(stateId));
    const selectedStateIds = [
        ...(plan.valveStateIds ?? (plan.valveIndexes.length === 0 ? currentStateIds : legacySelectedStateIds)),
    ].filter(stateId => currentStateIds.includes(stateId));
    const knownStateIds = plan.knownValveStateIds ?? currentStateIds;
    if (!explicitlyEmpty) {
        for (const stateId of currentStateIds) {
            if (!knownStateIds.includes(stateId) && !selectedStateIds.includes(stateId)) {
                selectedStateIds.push(stateId);
            }
        }
    }
    const valveIndexes = selectedStateIds.map(stateId => currentStateIds.indexOf(stateId));
    return {
        name: plan.name,
        valveIndexes: explicitlyEmpty ? [NONE_SENTINEL] : valveIndexes,
        valveStateIds: selectedStateIds,
        knownValveStateIds: currentStateIds,
    };
}

/**
 * Auto-discovery scan types. "Generic" additionally scans any adapter not
 * covered by a specific type. "All" runs every scan type (Gardena, Rainbird,
 * Homematic, Hydrawise, Generic) in one go, without any adapter instance restriction.
 */
export type ScanType = ValveType | 'All';

export interface IValveConfig {
    /**
     * Stable, never-reused numeric id assigned once when the valve is
     * created (see `IrrigationNativeConfig.nextValveId`). Used to build the
     * valve's real ioBroker object id (`valves.valve_XXX`, via
     * `formatValveNumber()`) and the read-only `valveNumber` display field,
     * so both stay constant even if the valve's row is later moved up/down
     * in the admin Valves table. Optional only for backwards compatibility
     * with configs/tests predating this field; `normalizeConfig()` always
     * fills it in (falling back to the valve's current array index for
     * pre-existing entries so their existing object id/state history is
     * preserved across the upgrade).
     */
    id?: number;
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
    /** Scheduled duration in seconds */
    duration: number;
    // --- expert fields (always present, neutral defaults when expert mode is off) ---
    rainIndependent: boolean;
    /** Percent, 0 = disabled */
    moistureThreshold: number;
    /** Optional foreign state id of the soil moisture sensor assigned to this valve */
    soilMoistureId?: string;
    /** Manual single-valve run duration in seconds */
    manualDuration: number;
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
    valveStateIds?: string[];
    knownValveStateIds?: string[];
}

export interface ISchedulerConfig {
    autoMode: boolean;
    pauseOnRain: boolean;
    /**
     * Minutes the rain sensor must report "no rain" continuously before
     * resuming watering. Mirrors windHysteresisMinutes: many rain sensors
     * (e.g. tipping-bucket gauges) toggle their boolean "rain detected"
     * state true/false in quick succession as individual drops register,
     * and without a resume delay every such flip would stop and restart
     * every currently running valve.
     */
    rainHysteresisMinutes: number;
    windPauseEnabled: boolean;
    windSpeedStateId: string;
    /** km/h, 0 = disabled */
    windSpeedLimit: number;
    windGustStateId: string;
    /** km/h, 0 = disabled */
    windGustLimit: number;
    /** Minutes wind/gust must stay below the limit before resuming */
    windHysteresisMinutes: number;
    /** "HH:MM" strings */
    timerTimes: string[];
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

/**
 * There is only ONE physical flow sensor in the supported hardware setup,
 * installed directly behind the water source (e.g. the pump), never one per
 * valve. `sensorId` is therefore a single global state id, and leak/deviation
 * detection in flow-monitor.ts always evaluates it against the set of valves
 * currently running (summed expected flow), never against a single valve in
 * isolation - except during calibration, where exactly one valve is opened
 * alone on purpose so its individual flow rate can be measured.
 */
export interface IFlowMonitorConfig {
    enabled: boolean;
    /** Foreign state id of the single flow sensor at the water source */
    sensorId: string;
}

export interface IrrigationNativeConfig {
    expertMode: boolean;
    valves: IValveConfig[];
    /**
     * Counter used to assign the next new valve's stable `IValveConfig.id`.
     * Always increments, never reused (even after valves are deleted), so a
     * deleted valve's old object id/state history can never be silently
     * inherited by an unrelated, later-added valve.
     */
    nextValveId: number;
    plans: IPlanConfig[];
    scheduler: ISchedulerConfig;
    sensors: ISensorsConfig;
    weather: IWeatherConfig;
    legalRestriction: ILegalRestrictionConfig;
    notifications: INotificationsConfig;
    waterConsumption: IWaterConsumptionConfig;
    flowMonitor: IFlowMonitorConfig;
}

/** Automation state machine status */
export type AutomationStatus = 'idle' | 'running' | 'paused';

/** What caused the automation to be paused/blocked, for status text + resume logic */
export type PauseReason = 'manual' | 'legalRestriction' | 'rain' | 'wind' | null;

/** A batch of valve indexes that run in parallel */
export type Batch = number[];

export interface IActiveValveRuntime {
    valveIndex: number;
    /** Effective duration in minutes for this run (already includes the temperature adjustment factor for automatic runs) */
    durationMinutes: number;
    startedAt: number;
}
