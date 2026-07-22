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
        temperatureStateId: '',
        startDate: '1.6',
        endDate: '30.9',
        startTime: '11:00',
        endTime: '17:00',
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
    const legacyRestriction = config.legalRestriction as
        | (Partial<IrrigationNativeConfig['legalRestriction']> & {
              monthStart?: number;
              monthEnd?: number;
              hourStart?: number;
              hourEnd?: number;
          })
        | undefined;
    const legacyStartMonth = legacyRestriction?.monthStart ?? 6;
    const legacyEndMonth = legacyRestriction?.monthEnd ?? 9;
    const legalRestriction = {
        ...DEFAULT_CONFIG.legalRestriction,
        ...config.legalRestriction,
        startDate: config.legalRestriction?.startDate ?? `1.${legacyStartMonth}`,
        endDate: config.legalRestriction?.endDate ?? `${new Date(2000, legacyEndMonth, 0).getDate()}.${legacyEndMonth}`,
        startTime:
            config.legalRestriction?.startTime ?? `${String(legacyRestriction?.hourStart ?? 11).padStart(2, '0')}:00`,
        endTime: config.legalRestriction?.endTime ?? `${String(legacyRestriction?.hourEnd ?? 17).padStart(2, '0')}:00`,
    };

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
        legalRestriction,
        notifications: { ...DEFAULT_CONFIG.notifications, ...config.notifications },
        waterConsumption: { ...DEFAULT_CONFIG.waterConsumption, ...config.waterConsumption },
    };
}
