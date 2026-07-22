/**
 * Unit tests for the pure/testable logic pieces of the irrigation adapter.
 * Focuses on functions that don't require a mocked ioBroker.Adapter instance,
 * per plan Phase 7 ("Unit-Tests for Valve-Controller, Automation, Scheduler").
 */

import { expect } from 'chai';
import { AutomationEngine, buildBatches } from './lib/automation';
import { parseDwdTemperature } from './lib/dwd';
import { resolvePlanFromIcalTitle } from './lib/scheduler';
import { parsePlanValveTableRows } from './lib/types';
import { ValveController } from './lib/ventile';
import type { AutomationDeps } from './lib/automation';
import type { IrrigationNativeConfig, IValveConfig } from './lib/types';

function makeValve(overrides: Partial<IValveConfig> = {}): IValveConfig {
    return {
        name: 'Valve',
        type: 'Generic',
        stateId: '',
        runFor: 600,
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
        expect((adapter as unknown as { foreignStates: Map<string, unknown> }).foreignStates.get(
            'rainbird.0.device.commands.stopIrrigation',
        )).to.equal(true);
    });

    it('suppresses allOffId when another zone of the same Rainbird controller is still running', async () => {
        const adapter = makeFakeAdapter();
        let valveA!: ValveController;
        let valveB!: ValveController;
        const getAllValves = (): ValveController[] => [valveA, valveB];
        valveA = new ValveController(
            adapter,
            0,
            rainbirdValve({ stateId: 'rainbird.0.device.stations.1' }),
            undefined,
            getAllValves,
        );
        valveB = new ValveController(
            adapter,
            1,
            rainbirdValve({ stateId: 'rainbird.0.device.stations.2' }),
            undefined,
            getAllValves,
        );

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
        let valveA!: ValveController;
        let valveB!: ValveController;
        const getAllValves = (): ValveController[] => [valveA, valveB];
        valveA = new ValveController(
            adapter,
            0,
            rainbirdValve({ stateId: 'rainbird.0.device.stations.1' }),
            undefined,
            getAllValves,
        );
        valveB = new ValveController(
            adapter,
            1,
            rainbirdValve({ stateId: 'rainbird.0.device.stations.2' }),
            undefined,
            getAllValves,
        );

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
        let valveA!: ValveController;
        let valveB!: ValveController;
        const getAllValves = (): ValveController[] => [valveA, valveB];
        valveA = new ValveController(
            adapter,
            0,
            rainbirdValve({ stateId: 'rainbird.0.device.stations.1', allOffId: 'rainbird.0.device.commands.stopIrrigation' }),
            undefined,
            getAllValves,
        );
        valveB = new ValveController(
            adapter,
            1,
            rainbirdValve({ stateId: 'rainbird.1.device.stations.1', allOffId: 'rainbird.1.device.commands.stopIrrigation' }),
            undefined,
            getAllValves,
        );

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
                monthStart: 6,
                monthEnd: 9,
                hourStart: 11,
                hourEnd: 17,
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
