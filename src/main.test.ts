/**
 * Unit tests for the pure/testable logic pieces of the irrigation adapter.
 * Focuses on functions that don't require a mocked ioBroker.Adapter instance,
 * per plan Phase 7 ("Unit-Tests for Valve-Controller, Automation, Scheduler").
 */

import { expect } from 'chai';
import { AutomationEngine, buildBatches, calculateTemperatureAdjustmentFactor } from './lib/automation';
import { parseDuration, formatDuration } from './lib/duration';
import { applyValveEditorFields, buildValveEditorOptions, getValveEditorFields } from './lib/valve-editor';
import { DwdRestriction, parseDwdTemperature } from './lib/dwd';
import { resolvePlanFromIcalTitle } from './lib/scheduler';
import { parsePlanValveTableRows, synchronizePlanWithValves } from './lib/types';
import { ValveController } from './lib/ventile';
import { evaluateWindPause, WindMonitor } from './lib/wind';
import { SensorManager } from './lib/sensors';
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
        days: [],
        ...overrides,
    };
}

describe('duration parsing and formatting', () => {
    it('accepts minutes, MM:SS and HH:MM:SS and stores seconds', () => {
        expect(parseDuration('10')).to.equal(600);
        expect(parseDuration('01:30')).to.equal(90);
        expect(parseDuration('01:02:03')).to.equal(3723);
    });

    it('formats durations as MM:SS or HH:MM:SS', () => {
        expect(formatDuration(90)).to.equal('01:30');
        expect(formatDuration(3723)).to.equal('01:02:03');
    });
});

describe('valve detail editor', () => {
    const valves = [
        makeValve({
            id: 8,
            name: 'Front lawn',
            stateId: 'garden.0.front',
            duration: 600,
            manualDuration: 90,
            days: [6, 2],
        }),
        makeValve({ id: 3, name: 'Back lawn', stateId: 'garden.0.back', duration: 300, manualDuration: 120, days: [] }),
    ];

    it('uses stable IDs in options even when table rows have been reordered', () => {
        expect(buildValveEditorOptions([valves[1], valves[0]])).to.deep.equal([
            { value: 3, label: '[003] Back lawn' },
            { value: 8, label: '[008] Front lawn' },
        ]);
    });

    it('loads formatted durations and sorted weekdays for the selected stable ID', () => {
        expect(getValveEditorFields(valves, 8)).to.include({
            _valveEditorName: 'Front lawn',
            _valveEditorDuration: '10:00',
            _valveEditorManualDuration: '01:30',
            _valveEditorDays: '2,6',
        });
    });

    it('updates only the selected valve and preserves table order', () => {
        const result = applyValveEditorFields([valves[1], valves[0]], 8, {
            _valveEditorName: 'Front lawn updated',
            _valveEditorType: 'Generic',
            _valveEditorStateId: 'garden.0.front',
            _valveEditorDuration: '12:00',
            _valveEditorEnabled: false,
            _valveEditorFlowRateLpm: 4.5,
            _valveEditorRainIndependent: true,
            _valveEditorMoistureThreshold: 40,
            _valveEditorManualDuration: '01:30',
            _valveEditorDays: '6, 2,2,0',
            _valveEditorAllOffId: '',
        });
        expect(result).to.not.have.property('error');
        if ('error' in result) {
            throw new Error(result.error);
        }
        expect(result.valves.map(valve => valve.id)).to.deep.equal([3, 8]);
        expect(result.valves[0].name).to.equal('Back lawn');
        expect(result.valves[1]).to.include({
            name: 'Front lawn updated',
            duration: 720,
            enabled: false,
            flowRateLpm: 4.5,
            rainIndependent: true,
            moistureThreshold: 40,
            manualDuration: 90,
        });
        expect(result.valves[1].days).to.deep.equal([0, 2, 6]);
    });

    it('accepts empty weekdays as every day', () => {
        const fields = getValveEditorFields(valves, 3);
        expect(fields).to.not.equal(undefined);
        const result = applyValveEditorFields(valves, 3, { ...fields, _valveEditorDays: '' });
        expect(result).to.not.have.property('error');
        if ('error' in result) {
            throw new Error(result.error);
        }
        expect(result.valves[1].days).to.deep.equal([]);
    });

    it('rejects invalid input without changing a valve', () => {
        const fields = getValveEditorFields(valves, 8);
        expect(fields).to.not.equal(undefined);
        expect(applyValveEditorFields(valves, 8, { ...fields, _valveEditorDays: '7' })).to.deep.equal({
            error: 'invalidDays',
        });
        expect(applyValveEditorFields(valves, 8, { ...fields, _valveEditorFlowRateLpm: -1 })).to.deep.equal({
            error: 'invalidNumbers',
        });
        expect(applyValveEditorFields(valves, 8, { ...fields, _valveEditorMoistureThreshold: 101 })).to.deep.equal({
            error: 'invalidNumbers',
        });
        expect(applyValveEditorFields(valves, 8, { ...fields, _valveEditorDuration: 'invalid' })).to.deep.equal({
            error: 'invalidDuration',
        });
        expect(applyValveEditorFields(valves, 999, fields)).to.deep.equal({ error: 'valveNotFound' });
    });
});

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
            flowMonitor: { enabled: false, sensorId: '' },
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

    /**
     * Regression test: parseAnnualDate's regex used to require dates without
     * leading zeros (e.g. "1.6"), so a zero-padded configured date like
     * "01.06" silently failed to parse, which made isWithinWindow() return
     * false and the legal restriction never activate for that user - even
     * though the date format is otherwise perfectly valid.
     */
    it('accepts zero-padded start/end dates and times (e.g. "01.06"/"08:00")', () => {
        const config = makeLegalRestrictionConfig({
            stationId: '',
            temperatureStateId: '',
            startDate: '01.06',
            endDate: '30.09',
            startTime: '08:00',
            endTime: '20:00',
        });
        const adapter = makeFakeAdapter();
        const dwd = new DwdRestriction({
            adapter,
            getConfig: () => config,
            onRestrictionChanged: () => Promise.resolve(),
        });

        // The exact result depends on "now", but a zero-padded date/time range
        // must be parsed (not treated as invalid/always-false) - this is
        // verified indirectly via the isWithinWindow behavior below using a
        // fixed date within the configured window.
        const fixedNow = new Date(2026, 6, 15, 12, 0); // July 15, 12:00 - within 01.06-30.09 / 08:00-20:00
        const isWithinWindow = (dwd as unknown as { isWithinWindow: (now: Date) => boolean }).isWithinWindow.bind(dwd);
        expect(isWithinWindow(fixedNow)).to.equal(true);

        const outsideDate = new Date(2026, 9, 15, 12, 0); // October 15 - outside the date range
        expect(isWithinWindow(outsideDate)).to.equal(false);
    });

    /**
     * Regression test: when hasDateRange is true but the configured
     * start/end date fails to parse (invalid format), the restriction used
     * to silently fall back to "not restricted" without any indication that
     * the configuration is broken. Now this logs a clear error.
     */
    it('logs a clear error and treats the window as inactive when the configured date range is malformed', async () => {
        const config = makeLegalRestrictionConfig({
            stationId: '',
            temperatureStateId: '',
            startDate: 'not-a-date',
            endDate: '30.09',
        });
        let loggedError = '';
        const adapter = {
            getForeignStateAsync: () => Promise.resolve(null),
            setStateAsync: () => Promise.resolve(),
            log: {
                debug: () => undefined,
                info: () => undefined,
                warn: () => undefined,
                error: (msg: string) => {
                    loggedError = msg;
                },
            },
        } as unknown as ioBroker.Adapter;
        const dwd = new DwdRestriction({
            adapter,
            getConfig: () => config,
            onRestrictionChanged: () => Promise.resolve(),
        });

        expect(await dwd.check()).to.equal(false);
        expect(loggedError).to.include('date range is invalid');
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
    const valves4 = Array.from({ length: 4 }, (_, id) => ({ id }));

    it('maps rows to valve indexes via valveNumber when rows are in natural order', () => {
        const rows = [
            { valveNumber: '000', assigned: false },
            { valveNumber: '001', assigned: true },
            { valveNumber: '002', assigned: false },
            { valveNumber: '003', assigned: true },
        ];
        expect(parsePlanValveTableRows(rows, valves4)).to.deep.equal([1, 3]);
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
        expect(parsePlanValveTableRows(rows, valves4)).to.deep.equal([3, 1]);
    });

    it('ignores rows with an out-of-range or malformed valveNumber', () => {
        const rows = [
            { valveNumber: '000', assigned: true },
            { valveNumber: '999', assigned: true },
            { valveNumber: 'abc', assigned: true },
            { valveNumber: undefined, assigned: true },
        ];
        expect(parsePlanValveTableRows(rows, valves4)).to.deep.equal([0]);
    });

    it('returns an empty array when no row is assigned', () => {
        const rows = [
            { valveNumber: '000', assigned: false },
            { valveNumber: '001', assigned: false },
        ];
        expect(parsePlanValveTableRows(rows, valves4.slice(0, 2))).to.deep.equal([]);
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
        public isRunning(): boolean {
            return true;
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
            valves: [makeValve({ name: 'Rasen', duration: 600 })],
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
            flowMonitor: { enabled: false, sensorId: '' },
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

        await engine.requestRun('All', 'manual-button');

        const expectedFactor = calculateTemperatureAdjustmentFactor(27);
        const expectedDurationSecs = Math.round(600 * expectedFactor);
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

        await engine.requestRun('All', 'manual-button');

        expect(valve.startCalls).to.deep.equal([600]); // unadjusted duration
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

        await engine.requestRun('All', 'manual-button');

        expect(valve.startCalls).to.deep.equal([600]);
    });
});

describe('scheduler.resolvePlanFromIcalTitle', () => {
    const planNames = ['All', 'Rasen', 'Beete'];

    it('returns the default plan when the title has no suffix', () => {
        expect(resolvePlanFromIcalTitle('Bewässerung', 'Bewässerung', planNames, 'All')).to.equal('All');
    });

    it('extracts the plan name after a colon', () => {
        expect(resolvePlanFromIcalTitle('Bewässerung: Rasen', 'Bewässerung', planNames, 'All')).to.equal('Rasen');
    });

    it('extracts the plan name after a dash', () => {
        expect(resolvePlanFromIcalTitle('Bewässerung - Beete', 'Bewässerung', planNames, 'All')).to.equal('Beete');
    });

    it('falls back to the default plan for an unknown plan name', () => {
        expect(resolvePlanFromIcalTitle('Bewässerung: Unbekannt', 'Bewässerung', planNames, 'All')).to.equal('All');
    });

    it('falls back to the default plan when the title does not match the prefix', () => {
        expect(resolvePlanFromIcalTitle('Anderes Event', 'Bewässerung', planNames, 'All')).to.equal('All');
    });
});

/**
 * Regression tests for AutomationEngine.recoverAfterRestart(). This is
 * called once from main.ts:onReady() on every adapter start. It
 * unconditionally stops every configured valve so the adapter always
 * starts from a known, consistent "all off" state, regardless of whether
 * an automation run was actually interrupted or a valve is currently being
 * controlled independently (e.g. from the Gardena app or another ioBroker
 * adapter).
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
            flowMonitor: { enabled: false, sensorId: '' },
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

    it('stops every configured valve on a fresh install / normal restart, even with no prior automation state', async () => {
        const valves = [new FakeValve(), new FakeValve(), new FakeValve()];
        const adapter = makeFakeAdapter(); // no automation.running state at all, like a fresh install
        const engine = new AutomationEngine(makeDeps(adapter, valves, makeConfig(valves.length)));

        await engine.recoverAfterRestart();

        for (const valve of valves) {
            expect(valve.stopCalls).to.equal(1);
        }
    });

    it('stops every configured valve even when automation.running is false, e.g. a valve running externally', async () => {
        const valves = [new FakeValve(), new FakeValve()];
        // Simulates: a Gardena valve was just started via the app or via ioBroker,
        // automation itself is idle. A restart must still bring it to a known "off" state.
        const adapter = makeFakeAdapter({ 'automation.running': false, 'automation.batchValves': '[]' });
        const engine = new AutomationEngine(makeDeps(adapter, valves, makeConfig(valves.length)));

        await engine.recoverAfterRestart();

        for (const valve of valves) {
            expect(valve.stopCalls).to.equal(1);
        }
    });

    it('stops every configured valve when automation.running is true, not just the ones in automation.batchValves', async () => {
        const valves = [new FakeValve(), new FakeValve(), new FakeValve()];
        const adapter = makeFakeAdapter({
            'automation.running': true,
            'automation.batchValves': JSON.stringify([0, 2]),
        });
        const engine = new AutomationEngine(makeDeps(adapter, valves, makeConfig(valves.length)));

        await engine.recoverAfterRestart();

        for (const valve of valves) {
            expect(valve.stopCalls).to.equal(1);
        }
    });

    it('stops every configured valve even when automation.batchValves is malformed', async () => {
        const valves = [new FakeValve(), new FakeValve()];
        const adapter = makeFakeAdapter({
            'automation.running': true,
            'automation.batchValves': 'not valid json',
        });
        const engine = new AutomationEngine(makeDeps(adapter, valves, makeConfig(valves.length)));

        await engine.recoverAfterRestart();

        for (const valve of valves) {
            expect(valve.stopCalls).to.equal(1);
        }
    });
});

/**
 * Regression tests for the critical resume-after-pause and overlapping-blocker
 * fixes in AutomationEngine (pause()/setRainPause()/setWindPause()/
 * onLegalRestrictionChanged()/manualStartValve()/finishManualRun()).
 */
describe('automation pause/resume: correct remaining time and overlapping blockers', () => {
    class FakeValve {
        public running = false;
        public startCalls: number[] = [];
        public stopCalls = 0;
        public start(durationSecs: number): Promise<void> {
            this.startCalls.push(durationSecs);
            this.running = true;
            return Promise.resolve();
        }
        public stop(): Promise<void> {
            this.stopCalls++;
            this.running = false;
            return Promise.resolve();
        }
        public isRunning(): boolean {
            return this.running;
        }
    }

    function makeFakeAdapter(): ioBroker.Adapter {
        const states = new Map<string, ioBroker.StateValue>();
        const fake = {
            setStateAsync: (id: string, state: unknown) => {
                states.set(id, (state as { val: ioBroker.StateValue }).val);
                return Promise.resolve();
            },
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
            states,
        };
        return fake as unknown as ioBroker.Adapter;
    }

    function makeConfig(overrides: Partial<IrrigationNativeConfig['scheduler']> = {}): IrrigationNativeConfig {
        return {
            expertMode: false,
            valves: [makeValve({ name: 'Rasen', duration: 600, manualDuration: 60 })],
            nextValveId: 0,
            plans: [{ name: 'All', valveIndexes: [] }],
            scheduler: {
                autoMode: false,
                pauseOnRain: true,
                windPauseEnabled: true,
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
                ...overrides,
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
            flowMonitor: { enabled: false, sensorId: '' },
        };
    }

    it('resume after a pause restarts the valve with the correct remaining time, not a shortened one', async () => {
        const config = makeConfig();
        const adapter = makeFakeAdapter();
        const valve = new FakeValve();
        const raining = false;
        const windOver = false;
        const legal = false;
        const engine = new AutomationEngine({
            adapter,
            getConfig: () => config,
            valves: [valve] as unknown as AutomationDeps['valves'],
            isValveBlockedForAutoRun: () => ({ blocked: false }),
            isLegallyRestricted: () => legal,
            isRaining: () => raining,
            isWindOverLimit: () => windOver,
            getTemperatureAdjustmentTemperature: () => Promise.resolve(undefined),
        });

        await engine.requestRun('All', 'manual-button');
        expect(valve.startCalls).to.deep.equal([600]);

        // Pause immediately, then simulate a long real-world pause (e.g. 100s) before
        // resuming. The remaining time at resume must reflect ~500s (600 - 100), not
        // the original 600s end timestamp computed at the initial start().
        await engine.pause();
        expect(valve.stopCalls).to.equal(1);

        const originalNow = Date.now;
        try {
            Date.now = () => originalNow() + 100_000;
            await engine.pause(); // resume
        } finally {
            Date.now = originalNow;
        }

        expect(valve.startCalls.length).to.equal(2);
        const resumedDuration = valve.startCalls[1];
        expect(resumedDuration).to.be.closeTo(500, 2);
    });

    it('does not resume while a second, still-active blocker (rain) remains after a legal restriction ends', async () => {
        const config = makeConfig();
        const adapter = makeFakeAdapter();
        const valve = new FakeValve();
        let raining = false;
        const windOver = false;
        let legal = false;
        const engine = new AutomationEngine({
            adapter,
            getConfig: () => config,
            valves: [valve] as unknown as AutomationDeps['valves'],
            isValveBlockedForAutoRun: () => ({ blocked: false }),
            isLegallyRestricted: () => legal,
            isRaining: () => raining,
            isWindOverLimit: () => windOver,
            getTemperatureAdjustmentTemperature: () => Promise.resolve(undefined),
        });

        await engine.requestRun('All', 'manual-button');
        expect(valve.startCalls).to.deep.equal([600]);

        // Legal restriction kicks in first.
        legal = true;
        await engine.onLegalRestrictionChanged(true);
        expect(valve.stopCalls).to.equal(1);
        expect(engine.getStatus()).to.equal('paused');

        // While still under legal restriction, rain also starts.
        raining = true;
        await engine.setRainPause(true);

        // Legal restriction ends, but rain is still active - must NOT resume.
        legal = false;
        await engine.onLegalRestrictionChanged(false);
        expect(engine.getStatus()).to.equal('paused');
        expect(valve.startCalls.length).to.equal(1); // still only the initial start, no resume

        // Rain ends too - now it must resume.
        raining = false;
        await engine.setRainPause(false);
        expect(engine.getStatus()).to.equal('running');
        expect(valve.startCalls.length).to.equal(2);
    });

    it('manualStartValve() refuses to start a disabled valve without pausing the running automation', async () => {
        const config = makeConfig();
        config.valves.push(makeValve({ name: 'Disabled valve', enabled: false, manualDuration: 30 }));
        const adapter = makeFakeAdapter();
        const valve0 = new FakeValve();
        const valve1 = new FakeValve();
        const engine = new AutomationEngine({
            adapter,
            getConfig: () => config,
            valves: [valve0, valve1] as unknown as AutomationDeps['valves'],
            isValveBlockedForAutoRun: () => ({ blocked: false }),
            isLegallyRestricted: () => false,
            isRaining: () => false,
            isWindOverLimit: () => false,
            getTemperatureAdjustmentTemperature: () => Promise.resolve(undefined),
        });

        await engine.requestRun('All', 'manual-button');
        expect(engine.getStatus()).to.equal('running');

        await engine.manualStartValve(1); // the disabled valve

        expect(engine.isManualRunActive()).to.equal(false);
        expect(engine.getStatus()).to.equal('running'); // automation was left untouched
        expect(valve1.startCalls).to.deep.equal([]); // disabled valve never started
    });
});

/**
 * Regression tests for the Rainbird "no allOffId" fail-open fix: stop()
 * must not report a fully "stopped/off" state when no hardware command
 * could actually be issued, since that would make the admin UI show the
 * valve as safely closed while the physical station may still be running.
 */
describe('ValveController Rainbird stop() without allOffId (no fail-open reporting)', () => {
    function makeFakeAdapter(): ioBroker.Adapter {
        const foreignStates = new Map<string, unknown>();
        const states = new Map<string, ioBroker.StateValue>();
        const fake = {
            setForeignStateAsync: (id: string, val: unknown) => {
                foreignStates.set(id, val);
                return Promise.resolve();
            },
            setStateAsync: (id: string, state: unknown) => {
                states.set(id, (state as { val: ioBroker.StateValue }).val);
                return Promise.resolve();
            },
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
            foreignStates,
            states,
        };
        return fake as unknown as ioBroker.Adapter;
    }

    it('leaves the valve reporting as running and records an error instead of falsely reporting "stopped"', async () => {
        const adapter = makeFakeAdapter();
        // No allOffId configured at all.
        const valve = new ValveController(
            adapter,
            0,
            makeValve({ type: 'Rainbird', stateId: 'rainbird.0.device.stations.1', allOffId: undefined }),
        );
        await valve.start(60);
        expect(valve.isRunning()).to.equal(true);

        await valve.stop();

        // Must NOT silently report "stopped" - the admin UI would otherwise show
        // the valve as safely off while the physical station may still be running.
        expect(valve.isRunning()).to.equal(true);
        const states = (adapter as unknown as { states: Map<string, ioBroker.StateValue> }).states;
        expect(states.get('valves.valve_000.state')).to.not.equal(false);
        expect(String(states.get('valves.valve_000.errorLast'))).to.include('allOffId');
    });
});

/**
 * Regression tests for parseDuration()'s explicit-value-vs-fallback
 * distinction: an explicitly provided but "empty" duration (0 or negative)
 * must never be silently replaced by the (often much longer) fallback,
 * while a truly absent value legitimately falls back.
 */
describe('duration.parseDuration explicit zero/negative vs. missing value', () => {
    it('uses the fallback for undefined/null/empty-string (no value provided)', () => {
        expect(parseDuration(undefined, 600)).to.equal(600);
        expect(parseDuration(null, 600)).to.equal(600);
        expect(parseDuration('', 600)).to.equal(600);
        expect(parseDuration('   ', 600)).to.equal(600);
    });

    it('clamps an explicit "0" string to 1s instead of falling back to the (much longer) fallback', () => {
        expect(parseDuration('0', 600)).to.equal(1);
        expect(parseDuration('00:00', 600)).to.equal(1);
    });

    it('clamps an explicit numeric 0/negative value to 1s instead of falling back', () => {
        expect(parseDuration(0, 600)).to.equal(1);
        expect(parseDuration(-5, 600)).to.equal(1);
    });

    it('still falls back for genuinely malformed input', () => {
        expect(parseDuration('abc', 600)).to.equal(600);
        expect(parseDuration('-5', 600)).to.equal(600); // regex-based parser never accepted a minus sign
    });
});

/**
 * Regression tests for WindMonitor's initial foreign-state read on
 * (re)subscribe. Previously speed/gust stayed undefined after an adapter
 * restart until the external sensor pushed a fresh value, which meant the
 * wind-pause protection was fail-open for an unbounded time right after
 * startup.
 */
describe('wind.WindMonitor initial sensor read', () => {
    function makeSchedulerConfig(overrides: Partial<IrrigationNativeConfig['scheduler']> = {}): IrrigationNativeConfig {
        return {
            expertMode: false,
            valves: [],
            nextValveId: 0,
            plans: [{ name: 'All', valveIndexes: [] }],
            scheduler: {
                autoMode: false,
                pauseOnRain: false,
                windPauseEnabled: true,
                windSpeedStateId: 'sensors.windSpeed',
                windSpeedLimit: 20,
                windGustStateId: 'sensors.windGust',
                windGustLimit: 40,
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
                ...overrides,
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
            flowMonitor: { enabled: false, sensorId: '' },
        };
    }

    function makeFakeAdapter(foreignStates: Record<string, ioBroker.StateValue>): ioBroker.Adapter {
        const fake = {
            getForeignStateAsync: (id: string) =>
                Promise.resolve(id in foreignStates ? ({ val: foreignStates[id] } as ioBroker.State) : null),
            subscribeForeignStatesAsync: () => Promise.resolve(),
            unsubscribeForeignStatesAsync: () => Promise.resolve(),
            setInterval: () => undefined as unknown as ReturnType<ioBroker.Adapter['setInterval']>,
            clearInterval: () => undefined,
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        };
        return fake as unknown as ioBroker.Adapter;
    }

    it('reads the current speed/gust foreign states immediately on init(), before any state-change event', async () => {
        const config = makeSchedulerConfig();
        const adapter = makeFakeAdapter({ 'sensors.windSpeed': 25, 'sensors.windGust': 10 });
        const pausedCalls: boolean[] = [];
        const monitor = new WindMonitor({
            adapter,
            getConfig: () => config,
            onWindPauseChange: paused => {
                pausedCalls.push(paused);
                return Promise.resolve();
            },
        });

        await monitor.init();

        // Speed (25) is already over the configured limit (20) purely from the
        // initial read - no onForeignStateChange() has been called yet.
        expect(monitor.isOverLimit()).to.equal(true);
        expect(pausedCalls).to.deep.equal([true]);
    });

    it('resets speed/gust to undefined and reloads fresh values when resubscribe() is called with new state ids', async () => {
        const config = makeSchedulerConfig({
            windSpeedStateId: 'sensors.windSpeedOld',
            windGustStateId: '',
            windHysteresisMinutes: 0,
        });
        const adapter = makeFakeAdapter({ 'sensors.windSpeedOld': 99, 'sensors.windSpeedNew': 5 });
        const monitor = new WindMonitor({
            adapter,
            getConfig: () => config,
            onWindPauseChange: () => Promise.resolve(),
        });

        await monitor.init();
        expect(monitor.isOverLimit()).to.equal(true); // 99 >= limit 20

        // Simulate a config change to a different (currently calm) sensor.
        config.scheduler.windSpeedStateId = 'sensors.windSpeedNew';
        await monitor.resubscribe();
        await (monitor as unknown as { evaluate: () => Promise<void> }).evaluate();

        // Must reflect the new sensor's current value (5, below the limit), not
        // stale data (99) left over from the previously configured sensor.
        expect(monitor.isOverLimit()).to.equal(false);
    });
});

/**
 * Regression tests for SensorManager: initial foreign-state read on init()
 * (fixing the fail-open default of rainState=false after a restart) and
 * stale-data detection for the rain/frost blocking predicates.
 */
describe('sensors.SensorManager initial read and stale-data detection', () => {
    function makeSensorsConfig(): IrrigationNativeConfig {
        return {
            expertMode: false,
            valves: [makeValve({ rainIndependent: false })],
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
                frostEnabled: true,
                frostMinTemp: 2,
                icalAdapterInstance: '',
                icalTriggerState: '',
                icalTitlePrefix: 'Bewässerung',
            },
            sensors: { rainId: 'sensors.rainSensor', soilMoistureId: '', temperatureId: 'sensors.outsideTemp' },
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
            flowMonitor: { enabled: false, sensorId: '' },
        };
    }

    function makeFakeAdapter(
        foreignStates: Record<string, { val: ioBroker.StateValue; ts?: number }>,
    ): ioBroker.Adapter {
        const fake = {
            getForeignStateAsync: (id: string) =>
                Promise.resolve(id in foreignStates ? (foreignStates[id] as ioBroker.State) : null),
            subscribeForeignStatesAsync: () => Promise.resolve(),
            unsubscribeForeignStatesAsync: () => Promise.resolve(),
            setStateAsync: () => Promise.resolve(),
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        };
        return fake as unknown as ioBroker.Adapter;
    }

    it('loads the current rain/temperature foreign-state values immediately on init(), instead of the fail-open defaults', async () => {
        const config = makeSensorsConfig();
        const adapter = makeFakeAdapter({
            'sensors.rainSensor': { val: true, ts: Date.now() },
            'sensors.outsideTemp': { val: -5, ts: Date.now() },
        });
        const sensors = new SensorManager({ adapter, getConfig: () => config });

        await sensors.init();

        expect(sensors.isRaining()).to.equal(true);
        expect(sensors.getTemperature()).to.equal(-5);
        // Frost protection must already be active from the initial read, not
        // just after the next onForeignStateChange() event.
        expect(sensors.isFrostBlocked()).to.equal(true);
        // Rain-blocking must also already be active for a non-rain-independent valve.
        expect(sensors.isValveBlocked(0).blocked).to.equal(true);
    });

    it('conservatively assumes frost protection is active when the temperature reading is stale', async () => {
        const config = makeSensorsConfig();
        const adapter = makeFakeAdapter({
            'sensors.rainSensor': { val: false, ts: Date.now() },
            'sensors.outsideTemp': { val: 15, ts: Date.now() - 3 * 60 * 60 * 1000 }, // 3h old, above 2h threshold
        });
        const sensors = new SensorManager({ adapter, getConfig: () => config });

        await sensors.init();

        // Temperature (15°C) itself is well above frostMinTemp (2°C), so
        // without staleness detection this would NOT be frost-blocked. The
        // stale reading must force a conservative "blocked" result instead.
        expect(sensors.isFrostBlocked()).to.equal(true);
    });

    it('does not block on frost when the temperature reading is fresh and above the threshold', async () => {
        const config = makeSensorsConfig();
        const adapter = makeFakeAdapter({
            'sensors.rainSensor': { val: false, ts: Date.now() },
            'sensors.outsideTemp': { val: 15, ts: Date.now() },
        });
        const sensors = new SensorManager({ adapter, getConfig: () => config });

        await sensors.init();

        expect(sensors.isFrostBlocked()).to.equal(false);
    });

    it('keeps the previous rain value and logs a warning when a state-change delivers an invalid (non-boolean) value', async () => {
        const config = makeSensorsConfig();
        const adapter = makeFakeAdapter({ 'sensors.rainSensor': { val: true, ts: Date.now() } });
        const warnings: string[] = [];
        (adapter as unknown as { log: { warn: (msg: string) => void } }).log.warn = (msg: string) => warnings.push(msg);
        const sensors = new SensorManager({ adapter, getConfig: () => config });
        await sensors.init();
        expect(sensors.isRaining()).to.equal(true);

        // Simulates an "unreachable" sensor reporting null instead of a boolean.
        await sensors.onForeignStateChange('sensors.rainSensor', { val: null } as unknown as ioBroker.State);

        expect(sensors.isRaining()).to.equal(true); // kept previous value, not reset to false
        expect(warnings.some(w => w.includes('no valid boolean value'))).to.equal(true);
    });
});
