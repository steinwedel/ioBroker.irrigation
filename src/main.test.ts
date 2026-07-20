/**
 * Unit tests for the pure/testable logic pieces of the irrigation adapter.
 * Focuses on functions that don't require a mocked ioBroker.Adapter instance,
 * per plan Phase 7 ("Unit-Tests for Valve-Controller, Automation, Scheduler").
 */

import { expect } from 'chai';
import { AutomationEngine, buildBatches } from './lib/automation';
import { parseDwdTemperature } from './lib/dwd';
import { resolvePlanFromIcalTitle } from './lib/scheduler';
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
