import type { IrrigationNativeConfig } from './types';

/**
 * Default configuration values. Used to defensively fill in missing fields
 * when the adapter is upgraded and new config fields are introduced.
 */
export const DEFAULT_CONFIG: IrrigationNativeConfig = {
    expertMode: false,
    valves: [],
    plans: [{ name: 'Alle', valveIndexes: [] }],
    scheduler: {
        autoMode: false,
        timerTimes: [],
        extensionFactor: 1,
        pumpCapacity: 0,
        valvePause: 0,
        seasonEnabled: false,
        seasonStart: 4,
        seasonEnd: 10,
        frostEnabled: false,
        frostMinTemp: 2,
        icalAdapterInstance: '',
        icalTriggerState: '',
        icalTitlePrefix: 'Bewässerung',
    },
    sensors: {
        rainId: '',
        soilMoistureId: '',
        temperatureId: '',
    },
    weather: {
        enabled: false,
        apiType: 'openweathermap',
        apiKey: '',
        latitude: 0,
        longitude: 0,
        pollInterval: 30,
    },
    legalRestriction: {
        enabled: false,
        stationId: '10400',
        monthStart: 6,
        monthEnd: 9,
        hourStart: 11,
        hourEnd: 17,
        minTemperature: 27,
        checkInterval: 10,
    },
    notifications: {
        pushoverInstance: '',
        telegramInstance: '',
    },
    waterConsumption: {
        enabled: false,
    },
};

/**
 * Merge a (possibly partial/older) config with defaults so newly introduced
 * fields are always present, without discarding existing user settings.
 *
 * @param config
 */
export function normalizeConfig(config: Partial<IrrigationNativeConfig>): IrrigationNativeConfig {
    return {
        expertMode: config.expertMode ?? DEFAULT_CONFIG.expertMode,
        valves: (config.valves ?? []).map(valve => ({
            name: valve.name ?? '',
            type: valve.type ?? 'Generic',
            stateId: valve.stateId ?? '',
            allOffId: valve.allOffId,
            runFor: valve.runFor ?? 600,
            enabled: valve.enabled ?? true,
            flowRateLpm: valve.flowRateLpm ?? 0,
            duration: valve.duration ?? 10,
            rainIndependent: valve.rainIndependent ?? false,
            moistureThreshold: valve.moistureThreshold ?? 0,
            manualDuration: valve.manualDuration ?? valve.duration ?? 10,
            flowSensorId: valve.flowSensorId ?? '',
            days: valve.days ?? [],
        })),
        plans:
            config.plans && config.plans.length > 0
                ? config.plans.map(p => ({ name: p.name ?? '', valveIndexes: p.valveIndexes ?? [] }))
                : DEFAULT_CONFIG.plans,
        scheduler: { ...DEFAULT_CONFIG.scheduler, ...config.scheduler },
        sensors: { ...DEFAULT_CONFIG.sensors, ...config.sensors },
        weather: { ...DEFAULT_CONFIG.weather, ...config.weather },
        legalRestriction: { ...DEFAULT_CONFIG.legalRestriction, ...config.legalRestriction },
        notifications: { ...DEFAULT_CONFIG.notifications, ...config.notifications },
        waterConsumption: { ...DEFAULT_CONFIG.waterConsumption, ...config.waterConsumption },
    };
}
