/**
 * Unit tests for the pure/testable logic pieces of the irrigation adapter.
 * Focuses on functions that don't require a mocked ioBroker.Adapter instance,
 * per plan Phase 7 ("Unit-Tests for Valve-Controller, Automation, Scheduler").
 */

import { expect } from 'chai';
import { buildBatches } from './lib/automation';
import { parseDwdTemperature } from './lib/dwd';
import { resolvePlanFromIcalTitle } from './lib/scheduler';
import type { IValveConfig } from './lib/types';

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
        groups: [],
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
