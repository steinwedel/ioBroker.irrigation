/**
 * Unit tests for the pure/testable logic pieces of the irrigation adapter.
 * Focuses on functions that don't require a mocked ioBroker.Adapter instance,
 * per plan Phase 7 ("Unit-Tests for Valve-Controller, Automation, Scheduler").
 */

import { expect } from 'chai';
import { AutomationEngine, buildBatches, calculateTemperatureAdjustmentFactor } from './lib/automation';
import { DwdRestriction, parseDwdTemperature } from './lib/dwd';
import { resolvePlanFromIcalTitle } from './lib/scheduler';
import { parsePlanValveTableRows, synchronizePlanWithValves } from './lib/types';
import { ValveController } from './lib/ventile';
import { evaluateWindPause } from './lib/wind';
import type { AutomationDeps } from './lib/automation';
import type { IPlanConfig, IrrigationNativeConfig, IValveConfig } from './lib/types';

function makeValve(overrides: Partial<IValveConfig> = {}): IValveConfig {
    return {
        name: 'Valve',
        type: 'Generic',
        stateId: '',
        enabled: true,
        flowRateLpm: 0,
        duration: 10,
        rainIndependent: false,
        moistureThreshold: 0,
        manualDuration: 10,
        flowSensorId: '',
        days: [],
        ...overrides,
    };
}

describe('automation.calculateTemperatureAdjustmentFactor', () => {
    it('uses 20 °C as the neutral factor', () => {
        expect(calculateTemperatureAdjustmentFactor(20)).to.equal(1);
    });

    it('increases by 7% for each degree above the base temperature', () => {
        expect(calculateTemperatureAdjustmentFactor(21)).to.equal(1.07);
        expect(calculateTemperatureAdjustmentFactor(22)).to.equal(1.07 ** 2);
    });

    it('reduces duration below the base temperature', () => {
        expect(calculateTemperatureAdjustmentFactor(10)).to.be.closeTo(1.07 ** -10, 0.000_000_1);
    });
});

/**
 * Regression tests for the pure wind/gust pause-with-hysteresis decision
 * function (see plan section "Windgrenze"/"Böen"/"Wind-Hysterese"). Covers
 * the speed limit, the separate gust limit, disabling a limit via 0,
 * immediate pausing when over a limit, and the resume hysteresis timing.
 */
describe('wind.evaluateWindPause', () => {
    const base = { speedLimit: 20, gustLimit: 40, belowSinceMs: null, nowMs: 1_000_000, hysteresisMs: 600_000 };

    it('pauses immediately once speed reaches the speed limit', () => {
        const result = evaluateWindPause({ ...base, speed: 20, gust: undefined });
        expect(result).to.deep.equal({ paused: true, belowSinceMs: null });
    });

    it('pauses immediately once gust reaches the gust limit, even if speed is fine', () => {
        const result = evaluateWindPause({ ...base, speed: 5, gust: 40 });
        expect(result).to.deep.equal({ paused: true, belowSinceMs: null });
    });

    it('does not pause when both are below their limits and the hysteresis has already elapsed', () => {
        const result = evaluateWindPause({
            ...base,
            speed: 10,
            gust: 20,
            belowSinceMs: base.nowMs - base.hysteresisMs,
        });
        expect(result.paused).to.equal(false);
    });

    it('a limit of 0 disables that check entirely', () => {
        const result = evaluateWindPause({
            ...base,
            speedLimit: 0,
            speed: 999,
            gust: 10,
            belowSinceMs: base.nowMs - base.hysteresisMs,
        });
        expect(result.paused).to.equal(false);
    });

    it('treats undefined sensor values as "not over limit"', () => {
        const result = evaluateWindPause({
            ...base,
            speed: undefined,
            gust: undefined,
            belowSinceMs: base.nowMs - base.hysteresisMs,
        });
        expect(result.paused).to.equal(false);
    });

    it('starts the hysteresis timer on the first below-limit evaluation and stays paused until it elapses', () => {
        const firstBelow = evaluateWindPause({ ...base, speed: 10, gust: 10, belowSinceMs: null, nowMs: 1_000_000 });
        expect(firstBelow).to.deep.equal({ paused: true, belowSinceMs: 1_000_000 });

        const stillWithinHysteresis = evaluateWindPause({
            ...base,
            speed: 10,
            gust: 10,
            belowSinceMs: firstBelow.belowSinceMs,
            nowMs: 1_000_000 + 300_000, // 5 min < 10 min hysteresis
        });
        expect(stillWithinHysteresis).to.deep.equal({ paused: true, belowSinceMs: 1_000_000 });

        const afterHysteresis = evaluateWindPause({
            ...base,
            speed: 10,
            gust: 10,
            belowSinceMs: firstBelow.belowSinceMs,
            nowMs: 1_000_000 + 600_000, // exactly 10 min hysteresis elapsed
        });
        expect(afterHysteresis).to.deep.equal({ paused: false, belowSinceMs: 1_000_000 });
    });

    it('resets belowSinceMs to null and restarts the hysteresis if wind goes back over the limit', () => {
        const stillOver = evaluateWindPause({ ...base, speed: 25, gust: 10, belowSinceMs: 500_000, nowMs: 1_000_000 });
        expect(stillOver).to.deep.equal({ paused: true, belowSinceMs: null });
    });
});

describe('automation.buildBatches', () => {
    it('returns one valve per batch when pumpCapacity is 0 (sequential mode)', () => {
        const valves = [makeValve({ duration: 5 }), makeValve({ duration: 10 }), makeValve({ duration: 3 })];
        const batches = buildBatches([0, 1, 2], valves, 0);
        expect(batches).to.deep.equal([[0], [1], [2]]);
    });

    it('groups valves into parallel batches respecting pump capacity', () => {
        const valves = [
            makeValve({ duration: 10, flowRateLpm: 10 }),
            makeValve({ duration: 8, flowRateLpm: 10 }),
            makeValve({ duration: 5, flowRateLpm: 15 }),
        ];
        const pumpCapacity = 20;
        const batches = buildBatches([0, 1, 2], valves, pumpCapacity);
        const flatSorted = batches.map(b => [...b].sort());
        const allIndexes = flatSorted.flat().sort();
        expect(allIndexes).to.deep.equal([0, 1, 2]);
    });

    it('never exceeds pump capacity within a single batch', () => {
        const valves = [
            makeValve({ duration: 10, flowRateLpm: 12 }),
            makeValve({ duration: 10, flowRateLpm: 12 }),
            makeValve({ duration: 10, flowRateLpm: 12 }),
        ];
        const pumpCapacity = 20;
        const batches = buildBatches([0, 1, 2], valves, pumpCapacity);
        for (const batch of batches) {
            const flowSum = batch.reduce((sum, idx) => sum + valves[idx].flowRateLpm, 0);
            expect(flowSum).to.be.at.most(pumpCapacity);
        }
    });

    it('puts a single valve in its own batch if its flow rate alone exceeds pump capacity', () => {
        const valves = [makeValve({ duration: 10, flowRateLpm: 50 })];
        const batches = buildBatches([0], valves, 20);
        expect(batches).to.deep.equal([[0]]);
    });

    it('never puts two Rainbird valves of the same controller instance in the same batch', () => {
        const valves = [
            makeValve({ type: 'Rainbird', stateId: 'rainbird.0.device.stations.1', duration: 10, flowRateLpm: 0 }),
            makeValve({ type: 'Rainbird', stateId: 'rainbird.0.device.stations.2', duration: 8, flowRateLpm: 0 }),
            makeValve({ type: 'Rainbird', stateId: 'rainbird.0.device.stations.3', duration: 5, flowRateLpm: 0 }),
        ];
        const pumpCapacity = 100;
        const batches = buildBatches([0, 1, 2], valves, pumpCapacity);
        expect(batches).to.deep.equal([[0], [1], [2]]);
    });

    it('still allows batching Rainbird valves from different controller instances together', () => {
        const valves = [
            makeValve({ type: 'Rainbird', stateId: 'rainbird.0.device.stations.1', duration: 10, flowRateLpm: 0 }),
            makeValve({ type: 'Rainbird', stateId: 'rainbird.1.device.stations.1', duration: 8, flowRateLpm: 0 }),
        ];
        const pumpCapacity = 100;
        const batches = buildBatches([0, 1], valves, pumpCapacity);
        expect(batches).to.deep.equal([[0, 1]]);
    });

    it('still allows batching a Rainbird valve together with a non-Rainbird valve', () => {
        const valves = [
            makeValve({ type: 'Rainbird', stateId: 'rainbird.0.device.stations.1', duration: 10, flowRateLpm: 0 }),
            makeValve({ type: 'Generic', stateId: 'irrigation.0.foo', duration: 8, flowRateLpm: 0 }),
        ];
        const pumpCapacity = 100;
        const batches = buildBatches([0, 1], valves, pumpCapacity);
        expect(batches).to.deep.equal([[0, 1]]);
    });
});

/**
 * Regression tests for the Rainbird `allOffId` ("stopIrrigation") guard in
 * ValveController.stop(). A Rainbird controller only exposes a single,
 * controller-wide stop command - there is no per-zone stop - so stop()
 * fires it to close the zone being stopped. Without the guard this would
 * also cut off any *other* zone of the same controller that is still
 * supposed to be running (e.g. a shorter-duration zone from the same
 * parallel pump-capacity batch, or a manual single-valve run started while
 * automation is paused/running). These tests lock in that the command is
 * only sent when no sibling zone of the same controller instance is still
 * running, while remaining unaffected for zones on different controllers
 * and for non-Rainbird valve types.
 */
describe('ValveController Rainbird allOffId guard', () => {
    function makeFakeAdapter(): ioBroker.Adapter {
        const foreignStates = new Map<string, unknown>();
        const fake = {
            setForeignStateAsync: (id: string, val: unknown) => {
                foreignStates.set(id, val);
                return Promise.resolve();
            },
            setStateAsync: () => Promise.resolve(),
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
            foreignStates,
        };
        return fake as unknown as ioBroker.Adapter;
    }

    function rainbirdValve(overrides: Partial<IValveConfig> = {}): IValveConfig {
        return makeValve({
            type: 'Rainbird',
            allOffId: 'rainbird.0.device.commands.stopIrrigation',
            ...overrides,
        });
    }

    it('fires allOffId when stopping the only running Rainbird valve on the controller', async () => {
        const adapter = makeFakeAdapter();
        // getAllValves is bound via the constructor default (() => [this]) here,
        // which is equivalent to main.ts's `() => this.valves` for a single valve.
        const valveA = new ValveController(adapter, 0, rainbirdValve({ stateId: 'rainbird.0.device.stations.1' }));
        await valveA.start(60);
        await valveA.stop();
        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get(
                'rainbird.0.device.commands.stopIrrigation',
            ),
        ).to.equal(true);
    });

    it('suppresses allOffId when another zone of the same Rainbird controller is still running', async () => {
        const adapter = makeFakeAdapter();
        const valves: ValveController[] = [];
        const getAllValves = (): ValveController[] => valves;
        const valveA = new ValveController(
            adapter,
            0,
            rainbirdValve({ stateId: 'rainbird.0.device.stations.1' }),
            undefined,
            getAllValves,
        );
        const valveB = new ValveController(
            adapter,
            1,
            rainbirdValve({ stateId: 'rainbird.0.device.stations.2' }),
            undefined,
            getAllValves,
        );
        valves.push(valveA, valveB);

        await valveA.start(60);
        await valveB.start(120);
        // Zone A finishes first while zone B (same controller) is still running.
        await valveA.stop();

        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.has(
                'rainbird.0.device.commands.stopIrrigation',
            ),
        ).to.equal(false);
    });

    it('fires allOffId once no other zone of the same controller is running anymore', async () => {
        const adapter = makeFakeAdapter();
        const valves: ValveController[] = [];
        const getAllValves = (): ValveController[] => valves;
        const valveA = new ValveController(
            adapter,
            0,
            rainbirdValve({ stateId: 'rainbird.0.device.stations.1' }),
            undefined,
            getAllValves,
        );
        const valveB = new ValveController(
            adapter,
            1,
            rainbirdValve({ stateId: 'rainbird.0.device.stations.2' }),
            undefined,
            getAllValves,
        );
        valves.push(valveA, valveB);

        await valveA.start(60);
        await valveB.start(120);
        await valveA.stop();
        await valveB.stop(); // last zone on this controller - now safe to send the shared stop

        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get(
                'rainbird.0.device.commands.stopIrrigation',
            ),
        ).to.equal(true);
    });

    it('does not suppress allOffId for a sibling valve on a different Rainbird controller instance', async () => {
        const adapter = makeFakeAdapter();
        const valves: ValveController[] = [];
        const getAllValves = (): ValveController[] => valves;
        const valveA = new ValveController(
            adapter,
            0,
            rainbirdValve({
                stateId: 'rainbird.0.device.stations.1',
                allOffId: 'rainbird.0.device.commands.stopIrrigation',
            }),
            undefined,
            getAllValves,
        );
        const valveB = new ValveController(
            adapter,
            1,
            rainbirdValve({
                stateId: 'rainbird.1.device.stations.1',
                allOffId: 'rainbird.1.device.commands.stopIrrigation',
            }),
            undefined,
            getAllValves,
        );
        valves.push(valveA, valveB);

        await valveA.start(60);
        await valveB.start(120);
        await valveA.stop();

        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get(
                'rainbird.0.device.commands.stopIrrigation',
            ),
        ).to.equal(true);
    });
});

/**
 * Regression tests for ValveController's per-type start/stop command
 * mapping and device-driven status updates (Gardena, Homematic, Hydrawise,
 * Generic). Rainbird's start/stop/status mapping and its shared allOffId
 * guard are covered separately above.
 */
describe('ValveController per-type start/stop/status', () => {
    function makeFakeAdapter(): ioBroker.Adapter {
        const foreignStates = new Map<string, unknown>();
        const fake = {
            setForeignStateAsync: (id: string, val: unknown) => {
                foreignStates.set(id, val);
                return Promise.resolve();
            },
            getForeignStateAsync: () => Promise.resolve(undefined),
            setStateAsync: () => Promise.resolve(),
            subscribeForeignStatesAsync: () => Promise.resolve(),
            setInterval: (handler: () => void, timeout: number) => global.setInterval(handler, timeout),
            clearInterval: (timer: NodeJS.Timeout) => global.clearInterval(timer),
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
            foreignStates,
        };
        return fake as unknown as ioBroker.Adapter;
    }

    it('Gardena: start writes the duration to duration_value, stop writes STOP_UNTIL_NEXT_TASK', async () => {
        const adapter = makeFakeAdapter();
        const valve = new ValveController(
            adapter,
            0,
            makeValve({ type: 'Gardena', stateId: 'smartgarden.0.DEVICE_x.SERVICE_VALVE_x.duration_value' }),
        );
        await valve.start(120);
        expect(valve.isRunning()).to.equal(true);
        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get(
                'smartgarden.0.DEVICE_x.SERVICE_VALVE_x.duration_value',
            ),
        ).to.equal('120');

        await valve.stop();
        expect(valve.isRunning()).to.equal(false);
        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get(
                'smartgarden.0.DEVICE_x.SERVICE_VALVE_x.duration_value',
            ),
        ).to.equal('STOP_UNTIL_NEXT_TASK');
    });

    it('Gardena: a device-reported activity_value of SCHEDULED_WATERING marks the valve as running', async () => {
        const adapter = makeFakeAdapter();
        const valve = new ValveController(
            adapter,
            0,
            makeValve({ type: 'Gardena', stateId: 'smartgarden.0.DEVICE_x.SERVICE_VALVE_x.duration_value' }),
        );
        await valve.onForeignStateChange('smartgarden.0.DEVICE_x.SERVICE_VALVE_x.activity_value', {
            val: 'SCHEDULED_WATERING',
        } as ioBroker.State);
        expect(valve.isRunning()).to.equal(true);

        await valve.onForeignStateChange('smartgarden.0.DEVICE_x.SERVICE_VALVE_x.activity_value', {
            val: 'CLOSED',
        } as ioBroker.State);
        expect(valve.isRunning()).to.equal(false);
    });

    it('Homematic: start sets ON_TIME and STATE=true, stop resets ON_TIME and sets STATE=false', async () => {
        const adapter = makeFakeAdapter();
        const valve = new ValveController(adapter, 0, makeValve({ type: 'Homematic', stateId: 'hm-rpc.3.ABC123.1' }));
        await valve.start(90);
        expect(valve.isRunning()).to.equal(true);
        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get(
                'hm-rpc.3.ABC123.1.STATE',
            ),
        ).to.equal(true);

        await valve.stop();
        expect(valve.isRunning()).to.equal(false);
        const foreignStates = (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates;
        expect(foreignStates.get('hm-rpc.3.ABC123.1.ON_TIME')).to.equal(0);
        expect(foreignStates.get('hm-rpc.3.ABC123.1.STATE')).to.equal(false);
    });

    it('Homematic: an externally reported STATE=true/false is reflected via isRunning()', async () => {
        const adapter = makeFakeAdapter();
        const valve = new ValveController(adapter, 0, makeValve({ type: 'Homematic', stateId: 'hm-rpc.3.ABC123.1' }));
        await valve.onForeignStateChange('hm-rpc.3.ABC123.1.STATE', { val: true } as ioBroker.State);
        expect(valve.isRunning()).to.equal(true);

        await valve.onForeignStateChange('hm-rpc.3.ABC123.1.STATE', { val: false } as ioBroker.State);
        expect(valve.isRunning()).to.equal(false);
    });

    it('Hydrawise: start writes seconds to runZone, stop writes stopZone=true', async () => {
        const adapter = makeFakeAdapter();
        const valve = new ValveController(
            adapter,
            0,
            makeValve({ type: 'Hydrawise', stateId: 'hydrawise.0.schedule.relay1.runZone' }),
        );
        await valve.start(300);
        expect(valve.isRunning()).to.equal(true);
        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get(
                'hydrawise.0.schedule.relay1.runZone',
            ),
        ).to.equal(300);

        await valve.stop();
        expect(valve.isRunning()).to.equal(false);
        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get(
                'hydrawise.0.schedule.relay1.stopZone',
            ),
        ).to.equal(true);
    });

    it('Hydrawise: a device-reported remaining time > 0 marks the valve as running', async () => {
        const adapter = makeFakeAdapter();
        const valve = new ValveController(
            adapter,
            0,
            makeValve({ type: 'Hydrawise', stateId: 'hydrawise.0.schedule.relay1.runZone' }),
        );
        await valve.onForeignStateChange('hydrawise.0.schedule.relay1.time', { val: 180 } as ioBroker.State);
        expect(valve.isRunning()).to.equal(true);

        await valve.onForeignStateChange('hydrawise.0.schedule.relay1.time', { val: 0 } as ioBroker.State);
        expect(valve.isRunning()).to.equal(false);
    });

    it('Generic: start sets the state to true, stop sets it to false', async () => {
        const adapter = makeFakeAdapter();
        const valve = new ValveController(adapter, 0, makeValve({ type: 'Generic', stateId: 'alias.0.mySwitch' }));
        await valve.start(60);
        expect(valve.isRunning()).to.equal(true);
        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get('alias.0.mySwitch'),
        ).to.equal(true);

        await valve.stop();
        expect(valve.isRunning()).to.equal(false);
        expect(
            (adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get('alias.0.mySwitch'),
        ).to.equal(false);
    });
});

describe('dwd.parseDwdTemperature', () => {
    it('parses a valid DWD POI CSV and returns the temperature', () => {
        const csv = [
            'Data description line',
            'Unit line',
            'Datum;Zeit;Temperatur (2m);Sonstige Spalte',
            '13.07.2026;12:00;24,5;100',
        ].join('\n');
        expect(parseDwdTemperature(csv)).to.equal(24.5);
    });

    it('returns null when the temperature column is missing', () => {
        const csv = ['Desc', 'Unit', 'Datum;Zeit;Sonstige Spalte', '13.07.2026;12:00;100'].join('\n');
        expect(parseDwdTemperature(csv)).to.equal(null);
    });

    it('returns null for empty or malformed input', () => {
        expect(parseDwdTemperature('')).to.equal(null);
        expect(parseDwdTemperature('a\nb\nc')).to.equal(null);
    });

    it('returns null when the data value is "---"', () => {
        const csv = ['Desc', 'Unit', 'Datum;Zeit;Temperatur (2m)', '13.07.2026;12:00;---'].join('\n');
        expect(parseDwdTemperature(csv)).to.equal(null);
    });
});

/**
 * Regression tests for DwdRestriction.check(), the "gesetzliche
 * Beregnungssperre" evaluation. Covers all three configured temperature
 * sources: a local temperature state (takes priority), a DWD POI station
 * (fetched via HTTP), and no temperature source at all (restriction applies
 * throughout the configured date/time window regardless of temperature).
 */
describe('dwd.DwdRestriction.check', () => {
    function makeLegalRestrictionConfig(
        overrides: Partial<IrrigationNativeConfig['legalRestriction']> = {},
    ): IrrigationNativeConfig {
        return {
            expertMode: false,
            valves: [],
            plans: [{ name: 'Alle', valveIndexes: [] }],
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
            sensors: { rainId: '', soilMoistureId: '', temperatureId: '' },
            weather: {
                enabled: false,
                apiType: 'openweathermap',
                apiKey: '',
                latitude: 0,
                longitude: 0,
                pollInterval: 30,
            },
            legalRestriction: {
                enabled: true,
                stationId: '',
                temperatureStateId: '',
                // Empty date/time range = always within window, so the
                // temperature-source behavior under test is isolated from
                // the date/time-window logic.
                startDate: '',
                endDate: '',
                startTime: '',
                endTime: '',
                minTemperature: 27,
                checkInterval: 10,
                ...overrides,
            },
            notifications: { pushoverInstance: '', telegramInstance: '' },
            waterConsumption: { enabled: false },
        };
    }

    function makeFakeAdapter(foreignStates: Record<string, ioBroker.StateValue> = {}): ioBroker.Adapter {
        const fake = {
            getForeignStateAsync: (id: string) =>
                Promise.resolve(id in foreignStates ? ({ val: foreignStates[id] } as ioBroker.State) : null),
            setStateAsync: () => Promise.resolve(),
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        };
        return fake as unknown as ioBroker.Adapter;
    }

    it('local temperature source: activates the restriction once the sensor reaches minTemperature', async () => {
        const config = makeLegalRestrictionConfig({ temperatureStateId: 'sensors.terrace_temp', minTemperature: 27 });
        const adapter = makeFakeAdapter({ 'sensors.terrace_temp': 28 });
        const dwd = new DwdRestriction({
            adapter,
            getConfig: () => config,
            onRestrictionChanged: () => Promise.resolve(),
        });

        const restricted = await dwd.check();
        expect(restricted).to.equal(true);
        expect(dwd.isActive()).to.equal(true);
    });

    it('local temperature source: stays inactive below minTemperature', async () => {
        const config = makeLegalRestrictionConfig({ temperatureStateId: 'sensors.terrace_temp', minTemperature: 27 });
        const adapter = makeFakeAdapter({ 'sensors.terrace_temp': 20 });
        const dwd = new DwdRestriction({
            adapter,
            getConfig: () => config,
            onRestrictionChanged: () => Promise.resolve(),
        });

        expect(await dwd.check()).to.equal(false);
    });

    it('DWD station source: fetches and parses the DWD POI CSV to decide the restriction', async () => {
        const config = makeLegalRestrictionConfig({ stationId: '10400', minTemperature: 27 });
        const adapter = makeFakeAdapter();
        const dwd = new DwdRestriction({
            adapter,
            getConfig: () => config,
            onRestrictionChanged: () => Promise.resolve(),
        });

        const csv = ['Desc', 'Unit', 'Datum;Zeit;Temperatur (2m)', '13.07.2026;12:00;30,0'].join('\n');
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() =>
            Promise.resolve({
                ok: true,
                status: 200,
                statusText: 'OK',
                text: () => Promise.resolve(csv),
            })) as unknown as typeof fetch;
        try {
            expect(await dwd.check()).to.equal(true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('DWD station source: keeps the previous state when the fetch fails', async () => {
        const config = makeLegalRestrictionConfig({ stationId: '10400', minTemperature: 27 });
        const adapter = makeFakeAdapter();
        const dwd = new DwdRestriction({
            adapter,
            getConfig: () => config,
            onRestrictionChanged: () => Promise.resolve(),
        });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = () => Promise.reject(new Error('network down'));
        try {
            expect(await dwd.check()).to.equal(false); // still the initial (never-restricted) state
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('no temperature source: applies the restriction throughout the window regardless of temperature', async () => {
        const config = makeLegalRestrictionConfig({ stationId: '', temperatureStateId: '' });
        const adapter = makeFakeAdapter();
        const dwd = new DwdRestriction({
            adapter,
            getConfig: () => config,
            onRestrictionChanged: () => Promise.resolve(),
        });

        expect(await dwd.check()).to.equal(true);
    });

    it('disabled restriction: never activates, even with a temperature source configured', async () => {
        const config = makeLegalRestrictionConfig({
            enabled: false,
            temperatureStateId: 'sensors.terrace_temp',
            minTemperature: 27,
        });
        const adapter = makeFakeAdapter({ 'sensors.terrace_temp': 40 });
        const dwd = new DwdRestriction({
            adapter,
            getConfig: () => config,
            onRestrictionChanged: () => Promise.resolve(),
        });

        expect(await dwd.check()).to.equal(false);
    });
});

/**
 * Regression tests for parsePlanValveTableRows(), the "Apply valve
 * assignment" handler's row->valve-index mapping for the Plans tab's
 * "Valves in selected plan" table. It used to interpret a row's position in
 * the `planValveTable` array as the real valve index directly, which broke
 * as soon as the admin UI's `table` component reordered rows (e.g. by
 * sorting a column) - after a reorder, row position no longer matched
 * `this.config2.valves` order, so the wrong valves ended up assigned to the
 * plan (this was the reported "wrong valves shown/assigned after selecting
 * a plan" bug). The fix matches each row back to its real valve index via
 * the unique, stable `valveNumber` field instead of the row's position.
 */
describe('main.parsePlanValveTableRows', () => {
    it('maps rows to valve indexes via valveNumber when rows are in natural order', () => {
        const rows = [
            { valveNumber: '000', assigned: false },
            { valveNumber: '001', assigned: true },
            { valveNumber: '002', assigned: false },
            { valveNumber: '003', assigned: true },
        ];
        expect(parsePlanValveTableRows(rows, 4)).to.deep.equal([1, 3]);
    });

    it('still returns the correct valve indexes after rows have been reordered (e.g. by sorting a column)', () => {
        // Same 4 valves as above, but the UI table has been sorted/reordered so
        // row position no longer matches valve index order. The old
        // position-based logic would have returned [0, 2] here (the row
        // positions of the checked rows) instead of the real valve indexes.
        const rows = [
            { valveNumber: '003', assigned: true },
            { valveNumber: '000', assigned: false },
            { valveNumber: '002', assigned: false },
            { valveNumber: '001', assigned: true },
        ];
        expect(parsePlanValveTableRows(rows, 4)).to.deep.equal([3, 1]);
    });

    it('ignores rows with an out-of-range or malformed valveNumber', () => {
        const rows = [
            { valveNumber: '000', assigned: true },
            { valveNumber: '999', assigned: true },
            { valveNumber: 'abc', assigned: true },
            { valveNumber: undefined, assigned: true },
        ];
        expect(parsePlanValveTableRows(rows, 4)).to.deep.equal([0]);
    });

    it('returns an empty array when no row is assigned', () => {
        const rows = [
            { valveNumber: '000', assigned: false },
            { valveNumber: '001', assigned: false },
        ];
        expect(parsePlanValveTableRows(rows, 2)).to.deep.equal([]);
    });
});

/**
 * Regression tests for synchronizePlanWithValves(), which reconciles a
 * plan's stable-ID valve assignment against the current Valves tab whenever
 * plans.plansData is loaded or saved. Matching is by valve.stateId, not by
 * array index or name, so adding/removing/renaming valves in the Valves tab
 * keeps existing plan assignments correct without manual rework.
 */
describe('main.synchronizePlanWithValves', () => {
    const basePlan = (overrides: Partial<IPlanConfig> = {}): IPlanConfig => ({
        name: 'Test',
        valveIndexes: [0, 1],
        valveStateIds: ['a', 'b'],
        knownValveStateIds: ['a', 'b'],
        ...overrides,
    });

    it('automatically includes a newly added valve in a non-empty plan', () => {
        const result = synchronizePlanWithValves(basePlan(), ['a', 'b', 'c']);
        expect(result.valveStateIds).to.deep.equal(['a', 'b', 'c']);
        expect(result.valveIndexes).to.deep.equal([0, 1, 2]);
    });

    it('does not add a newly added valve to a plan that was explicitly emptied', () => {
        const plan = basePlan({ valveIndexes: [-1], valveStateIds: [], knownValveStateIds: ['a', 'b'] });
        const result = synchronizePlanWithValves(plan, ['a', 'b', 'c']);
        expect(result.valveStateIds).to.deep.equal([]);
        expect(result.valveIndexes).to.deep.equal([-1]);
    });

    it('drops a removed valve from the assignment and reindexes the rest', () => {
        const plan = basePlan({
            valveIndexes: [0, 1, 2],
            valveStateIds: ['a', 'b', 'c'],
            knownValveStateIds: ['a', 'b', 'c'],
        });
        const result = synchronizePlanWithValves(plan, ['a', 'c']);
        expect(result.valveStateIds).to.deep.equal(['a', 'c']);
        expect(result.valveIndexes).to.deep.equal([0, 1]);
    });

    it('keeps a valve assigned after it was renamed or moved (matched by stateId, not index)', () => {
        // "b" moved from index 1 to index 0 (e.g. reordered in the Valves tab); the
        // plan still assigns it correctly via its stable stateId.
        const result = synchronizePlanWithValves(basePlan(), ['b', 'a']);
        expect(result.valveStateIds).to.deep.equal(['a', 'b']);
        expect(result.valveIndexes.sort()).to.deep.equal([0, 1]);
    });
});

/**
 * End-to-end regression test for the temperature-controlled irrigation
 * adjustment: verifies that AutomationEngine.requestRun() fixes the factor
 * 1.07^(T-20) once at plan start, publishes it, and applies it (together
 * with the duration extension factor) to the actual valve start command for
 * a full plan run - not just to the pure calculateTemperatureAdjustmentFactor()
 * helper, which is already covered separately above.
 */
describe('automation temperature-controlled irrigation adjustment (full plan run)', () => {
    class FakeAdjustmentValve {
        public startCalls: number[] = [];
        public start(durationSecs: number): Promise<void> {
            this.startCalls.push(durationSecs);
            return Promise.resolve();
        }
        public stop(): Promise<void> {
            return Promise.resolve();
        }
    }

    function makeFakeAdapter(): ioBroker.Adapter {
        const states = new Map<string, ioBroker.StateValue>();
        const fake = {
            getStateAsync: (id: string) =>
                Promise.resolve(states.has(id) ? ({ val: states.get(id) } as ioBroker.State) : null),
            setStateAsync: (id: string, state: unknown) => {
                states.set(id, (state as { val: ioBroker.StateValue }).val);
                return Promise.resolve();
            },
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
            states,
        };
        return fake as unknown as ioBroker.Adapter;
    }

    function makeAdjustmentConfig(temperatureAdjustmentEnabled: boolean): IrrigationNativeConfig {
        return {
            expertMode: false,
            valves: [makeValve({ name: 'Rasen', duration: 10 })],
            plans: [{ name: 'Alle', valveIndexes: [] }],
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
                temperatureAdjustmentEnabled,
                temperatureAdjustmentStateId: temperatureAdjustmentEnabled ? 'sensors.outside_temp' : '',
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
            sensors: { rainId: '', soilMoistureId: '', temperatureId: '' },
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
                stationId: '',
                temperatureStateId: '',
                startDate: '',
                endDate: '',
                startTime: '',
                endTime: '',
                minTemperature: 27,
                checkInterval: 10,
            },
            notifications: { pushoverInstance: '', telegramInstance: '' },
            waterConsumption: { enabled: false },
        };
    }

    it('fixes the 1.07^(T-20) factor at plan start and applies it to the actual valve start duration', async () => {
        const config = makeAdjustmentConfig(true);
        const adapter = makeFakeAdapter();
        const valve = new FakeAdjustmentValve();
        const engine = new AutomationEngine({
            adapter,
            getConfig: () => config,
            valves: [valve] as unknown as AutomationDeps['valves'],
            isValveBlockedForAutoRun: () => ({ blocked: false }),
            isLegallyRestricted: () => false,
            isRaining: () => false,
            isWindOverLimit: () => false,
            getTemperatureAdjustmentTemperature: () => Promise.resolve(27), // 7°C above the 20°C base
        });

        await engine.requestRun('Alle', 'manual-button');

        const expectedFactor = calculateTemperatureAdjustmentFactor(27);
        const expectedDurationSecs = Math.round(10 * 1 * expectedFactor * 60);
        expect(valve.startCalls).to.deep.equal([expectedDurationSecs]);
        expect(
            (adapter as unknown as { states: Map<string, ioBroker.StateValue> }).states.get(
                'automation.temperatureAdjustmentFactor',
            ),
        ).to.equal(expectedFactor);
    });

    it('falls back to a factor of 1 (no adjustment) when the temperature state has no valid value', async () => {
        const config = makeAdjustmentConfig(true);
        const adapter = makeFakeAdapter();
        const valve = new FakeAdjustmentValve();
        const engine = new AutomationEngine({
            adapter,
            getConfig: () => config,
            valves: [valve] as unknown as AutomationDeps['valves'],
            isValveBlockedForAutoRun: () => ({ blocked: false }),
            isLegallyRestricted: () => false,
            isRaining: () => false,
            isWindOverLimit: () => false,
            getTemperatureAdjustmentTemperature: () => Promise.resolve(undefined),
        });

        await engine.requestRun('Alle', 'manual-button');

        expect(valve.startCalls).to.deep.equal([Math.round(10 * 60)]); // unadjusted duration
        expect(
            (adapter as unknown as { states: Map<string, ioBroker.StateValue> }).states.get(
                'automation.temperatureAdjustmentFactor',
            ),
        ).to.equal(1);
    });

    it('does not apply any adjustment when the feature is disabled', async () => {
        const config = makeAdjustmentConfig(false);
        const adapter = makeFakeAdapter();
        const valve = new FakeAdjustmentValve();
        const engine = new AutomationEngine({
            adapter,
            getConfig: () => config,
            valves: [valve] as unknown as AutomationDeps['valves'],
            isValveBlockedForAutoRun: () => ({ blocked: false }),
            isLegallyRestricted: () => false,
            isRaining: () => false,
            isWindOverLimit: () => false,
            getTemperatureAdjustmentTemperature: () => Promise.resolve(35), // must be ignored while disabled
        });

        await engine.requestRun('Alle', 'manual-button');

        expect(valve.startCalls).to.deep.equal([Math.round(10 * 60)]);
    });
});

describe('scheduler.resolvePlanFromIcalTitle', () => {
    const planNames = ['Alle', 'Rasen', 'Beete'];

    it('returns the default plan when the title has no suffix', () => {
        expect(resolvePlanFromIcalTitle('Bewässerung', 'Bewässerung', planNames, 'Alle')).to.equal('Alle');
    });

    it('extracts the plan name after a colon', () => {
        expect(resolvePlanFromIcalTitle('Bewässerung: Rasen', 'Bewässerung', planNames, 'Alle')).to.equal('Rasen');
    });

    it('extracts the plan name after a dash', () => {
        expect(resolvePlanFromIcalTitle('Bewässerung - Beete', 'Bewässerung', planNames, 'Alle')).to.equal('Beete');
    });

    it('falls back to the default plan for an unknown plan name', () => {
        expect(resolvePlanFromIcalTitle('Bewässerung: Unbekannt', 'Bewässerung', planNames, 'Alle')).to.equal('Alle');
    });

    it('falls back to the default plan when the title does not match the prefix', () => {
        expect(resolvePlanFromIcalTitle('Anderes Event', 'Bewässerung', planNames, 'Alle')).to.equal('Alle');
    });
});

/**
 * Regression tests for AutomationEngine.recoverAfterRestart(). This is
 * called once from main.ts:onReady() on every adapter start. It used to
 * unconditionally call stop() on every configured valve regardless of
 * whether an automation run was actually interrupted - which meant a
 * Gardena valve started moments earlier (from the Gardena app or from
 * ioBroker) was immediately closed again by the very next adapter restart.
 * These tests lock in the fix: only stop valves that automation.batchZones
 * says were genuinely part of an interrupted run, and only when
 * automation.running confirms a run was in progress.
 */
describe('automation.recoverAfterRestart', () => {
    class FakeValve {
        public stopCalls = 0;
        public stop(): Promise<void> {
            this.stopCalls++;
            return Promise.resolve();
        }
    }

    function makeFakeAdapter(initialStates: Record<string, ioBroker.StateValue> = {}): ioBroker.Adapter {
        const states = new Map<string, ioBroker.StateValue>(Object.entries(initialStates));
        const fake = {
            getStateAsync: (id: string) => {
                if (!states.has(id)) {
                    return Promise.resolve(null);
                }
                return Promise.resolve({ val: states.get(id) } as ioBroker.State);
            },
            setStateAsync: (id: string, state: unknown) => {
                states.set(id, (state as { val: ioBroker.StateValue }).val);
                return Promise.resolve();
            },
            setInterval: () => undefined as unknown as ReturnType<ioBroker.Adapter['setInterval']>,
            clearInterval: () => undefined,
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        };
        return fake as unknown as ioBroker.Adapter;
    }

    function makeConfig(valveCount: number): IrrigationNativeConfig {
        return {
            expertMode: false,
            valves: Array.from({ length: valveCount }, () => makeValve()),
            plans: [{ name: 'Alle', valveIndexes: [] }],
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
            sensors: { rainId: '', soilMoistureId: '', temperatureId: '' },
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
                stationId: '',
                temperatureStateId: '',
                startDate: '1.6',
                endDate: '30.9',
                startTime: '11:00',
                endTime: '17:00',
                minTemperature: 27,
                checkInterval: 10,
            },
            notifications: { pushoverInstance: '', telegramInstance: '' },
            waterConsumption: { enabled: false },
        };
    }

    function makeDeps(adapter: ioBroker.Adapter, valves: FakeValve[], config: IrrigationNativeConfig): AutomationDeps {
        return {
            adapter,
            getConfig: () => config,
            valves: valves as unknown as AutomationDeps['valves'],
            isValveBlockedForAutoRun: () => ({ blocked: false }),
            isLegallyRestricted: () => false,
            isRaining: () => false,
            isWindOverLimit: () => false,
            getTemperatureAdjustmentTemperature: () => Promise.resolve(undefined),
        };
    }

    it('does not stop any valve when no automation run was in progress (fresh install / normal restart)', async () => {
        const valves = [new FakeValve(), new FakeValve(), new FakeValve()];
        const adapter = makeFakeAdapter(); // no automation.running state at all, like a fresh install
        const engine = new AutomationEngine(makeDeps(adapter, valves, makeConfig(valves.length)));

        await engine.recoverAfterRestart();

        for (const valve of valves) {
            expect(valve.stopCalls).to.equal(0);
        }
    });

    it('does not stop any valve when automation.running is false, even if a valve is running externally', async () => {
        const valves = [new FakeValve(), new FakeValve()];
        // Simulates: a Gardena valve was just started via the app or via ioBroker,
        // automation itself is idle. The bug used to stop this valve anyway.
        const adapter = makeFakeAdapter({ 'automation.running': false, 'automation.batchZones': '[]' });
        const engine = new AutomationEngine(makeDeps(adapter, valves, makeConfig(valves.length)));

        await engine.recoverAfterRestart();

        for (const valve of valves) {
            expect(valve.stopCalls).to.equal(0);
        }
    });

    it('stops only the valves recorded in automation.batchZones when automation.running is true', async () => {
        const valves = [new FakeValve(), new FakeValve(), new FakeValve()];
        // Simulates: the adapter crashed mid-run while valves 0 and 2 were part of the
        // active batch; valve 1 was never part of it and must not be touched.
        const adapter = makeFakeAdapter({
            'automation.running': true,
            'automation.batchZones': JSON.stringify([0, 2]),
        });
        const engine = new AutomationEngine(makeDeps(adapter, valves, makeConfig(valves.length)));

        await engine.recoverAfterRestart();

        expect(valves[0].stopCalls).to.equal(1);
        expect(valves[1].stopCalls).to.equal(0);
        expect(valves[2].stopCalls).to.equal(1);
    });

    it('does not throw and stops nothing when automation.running is true but batchZones is malformed', async () => {
        const valves = [new FakeValve(), new FakeValve()];
        const adapter = makeFakeAdapter({
            'automation.running': true,
            'automation.batchZones': 'not valid json',
        });
        const engine = new AutomationEngine(makeDeps(adapter, valves, makeConfig(valves.length)));

        await engine.recoverAfterRestart();

        for (const valve of valves) {
            expect(valve.stopCalls).to.equal(0);
        }
    });
});
