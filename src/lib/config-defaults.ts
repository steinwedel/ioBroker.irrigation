import { parseDuration } from './duration';
import type { IrrigationNativeConfig } from './types';

/**
 * Default configuration values. Used to defensively fill in missing fields
 * when the adapter is upgraded and new config fields are introduced.
 */
export const DEFAULT_CONFIG: IrrigationNativeConfig = {
    expertMode: false,
    valves: [],
    nextValveId: 0,
    plans: [{ name: 'All', valveIndexes: [] }],
    scheduler: {
        autoMode: false,
        pauseOnRain: false,
        windPauseEnabled: false,
        windSpeedStateId: '',
        windSpeedLimit: 0,
        windGustStateId: '',
        windGustLimit: 0,
        windHysteresisMinutes: 10,
        timerTimes: [],
        extensionFactor: 1,
        temperatureAdjustmentEnabled: false,
        temperatureAdjustmentStateId: '',
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
    flowMonitor: {
        enabled: false,
        sensorId: '',
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

    const legacySoilMoistureId = config.sensors?.soilMoistureId?.trim() || undefined;

    return {
        expertMode: config.expertMode ?? DEFAULT_CONFIG.expertMode,
        valves: (Array.isArray(config.valves) ? config.valves : []).map((valve, index) => {
            const legacyRunFor = (valve as Partial<IrrigationNativeConfig['valves'][number]> & { runFor?: number })
                .runFor;
            const duration =
                typeof valve.duration === 'number'
                    ? Math.max(1, Math.round(valve.duration * 60))
                    : Math.max(1, parseDuration(valve.duration ?? (legacyRunFor !== undefined ? legacyRunFor : '10')));
            return {
                // Falls back to the current array index only for pre-existing entries
                // that predate this field, so their real ioBroker object id (which is
                // derived from `id`, see formatValveNumber()) stays exactly what it
                // already was - see the IValveConfig.id doc comment.
                id: typeof valve.id === 'number' ? valve.id : index,
                name: valve.name ?? '',
                type: valve.type ?? 'Generic',
                stateId: valve.stateId ?? '',
                allOffId: valve.allOffId,
                enabled: valve.enabled ?? true,
                flowRateLpm: valve.flowRateLpm ?? 0,
                duration,
                rainIndependent: valve.rainIndependent ?? false,
                moistureThreshold: valve.moistureThreshold ?? 0,
                soilMoistureId: valve.soilMoistureId?.trim() || legacySoilMoistureId,
                manualDuration:
                    typeof valve.manualDuration === 'number'
                        ? Math.max(1, Math.round(valve.manualDuration * 60))
                        : valve.manualDuration === undefined
                          ? duration
                          : Math.max(1, parseDuration(valve.manualDuration)),
                days: valve.days ?? [],
            };
        }),
        nextValveId: config.nextValveId ?? DEFAULT_CONFIG.nextValveId,
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
        flowMonitor: { ...DEFAULT_CONFIG.flowMonitor, ...config.flowMonitor },
    };
}
