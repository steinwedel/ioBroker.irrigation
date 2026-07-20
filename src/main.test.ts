/**
 * Unit tests for the pure/testable logic pieces of the irrigation adapter.
 * Focuses on functions that don't require a mocked ioBroker.Adapter instance,
 * per plan Phase 7 ("Unit-Tests für Valve-Controller, Automation, Scheduler").
 */

import { expect } from 'chai';
import { buildBatches } from './lib/automation';
import { parseDwdTemperature } from './lib/dwd';
import { resolvePlanFromIcalTitle } from './lib/scheduler';
import type { IZoneConfig } from './lib/types';

function makeZone(overrides: Partial<IZoneConfig> = {}): IZoneConfig {
    return {
        name: 'Zone',
        valveIndex: 0,
        duration: 10,
        enabled: true,
        rainIndependent: false,
        moistureThreshold: 0,
        manualDuration: 10,
        flowSensorId: '',
        flowRate: 0,
        groups: [],
        days: [],
        ...overrides,
    };
}

describe('automation.buildBatches', () => {
    it('returns one zone per batch when pumpCapacity is 0 (sequential mode)', () => {
        const zones = [makeZone({ duration: 5 }), makeZone({ duration: 10 }), makeZone({ duration: 3 })];
        const batches = buildBatches([0, 1, 2], zones, 0);
        expect(batches).to.deep.equal([[0], [1], [2]]);
    });

    it('groups zones into parallel batches respecting pump capacity', () => {
        const zones = [
            makeZone({ duration: 10, flowRate: 10 }),
            makeZone({ duration: 8, flowRate: 10 }),
            makeZone({ duration: 5, flowRate: 15 }),
        ];
        // pumpCapacity 20: zone0+zone1 fit together (20), zone2 (15) needs its own batch
        // because it does not fit into a batch that already has flowSum 20.
        const batches = buildBatches([0, 1, 2], zones, 20);
        const flatSorted = batches.map(b => [...b].sort());
        // all zone indexes must appear exactly once across all batches
        const allIndexes = flatSorted.flat().sort();
        expect(allIndexes).to.deep.equal([0, 1, 2]);
    });

    it('never exceeds pump capacity within a single batch', () => {
        const zones = [
            makeZone({ duration: 10, flowRate: 12 }),
            makeZone({ duration: 10, flowRate: 12 }),
            makeZone({ duration: 10, flowRate: 12 }),
        ];
        const pumpCapacity = 20;
        const batches = buildBatches([0, 1, 2], zones, pumpCapacity);
        for (const batch of batches) {
            const flowSum = batch.reduce((sum, idx) => sum + zones[idx].flowRate, 0);
            expect(flowSum).to.be.at.most(pumpCapacity);
        }
    });

    it('puts a single zone in its own batch if its flow rate alone exceeds pump capacity', () => {
        const zones = [makeZone({ duration: 10, flowRate: 50 })];
        const batches = buildBatches([0], zones, 20);
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
