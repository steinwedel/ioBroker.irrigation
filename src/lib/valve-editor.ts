import { normalizeConfig } from './config-defaults';
import { formatDuration, parseDuration } from './duration';
import type { IValveConfig, ValveType } from './types';
import { formatValveNumber } from './types';

export interface ValveEditorFields {
    _valveEditorName: string;
    _valveEditorType: ValveType;
    _valveEditorStateId: string;
    _valveEditorDuration: string;
    _valveEditorEnabled: boolean;
    _valveEditorFlowRateLpm: number;
    _valveEditorRainIndependent: boolean;
    _valveEditorMoistureThreshold: number;
    _valveEditorSoilMoistureId: string;
    _valveEditorManualDuration: string;
    _valveEditorDays: string;
    _valveEditorAllOffId: string;
}

export type ValveEditorError =
    'noValveSelected' | 'valveNotFound' | 'invalidDuration' | 'invalidDays' | 'invalidNumbers';

export type ValveEditorApplyResult = { valves: IValveConfig[] } | { error: ValveEditorError };

function normalizeEditorValves(rawValves: unknown): IValveConfig[] | undefined {
    if (!Array.isArray(rawValves)) {
        return undefined;
    }
    const editorValves = rawValves.map(rawValve => {
        if (!rawValve || typeof rawValve !== 'object') {
            return rawValve;
        }
        const valve = rawValve as Record<string, unknown>;
        return {
            ...valve,
            duration: typeof valve.duration === 'number' ? formatDuration(valve.duration) : valve.duration,
            manualDuration:
                typeof valve.manualDuration === 'number' ? formatDuration(valve.manualDuration) : valve.manualDuration,
        };
    });
    return normalizeConfig({ valves: editorValves as IValveConfig[] }).valves;
}

function readValveId(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseEditorDuration(value: unknown): number | undefined {
    if (typeof value !== 'string' || !/^(?:\d+|(?:\d+:)?[0-5]\d:[0-5]\d)$/.test(value.trim())) {
        return undefined;
    }
    return parseDuration(value);
}

function parseEditorDays(value: unknown): number[] | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const text = value.trim();
    if (!text) {
        return [];
    }
    if (!/^[0-6](?:\s*,\s*[0-6])*$/.test(text)) {
        return undefined;
    }
    return [...new Set(text.split(',').map(day => Number(day.trim())))].sort((a, b) => a - b);
}

function isValveType(value: unknown): value is ValveType {
    return (
        value === 'Gardena' ||
        value === 'Homematic' ||
        value === 'Rainbird' ||
        value === 'Hydrawise' ||
        value === 'Generic'
    );
}

function readTrimmedString(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim() : undefined;
}

export function buildValveEditorOptions(rawValves: unknown): Array<{ label: string; value: number }> {
    const valves = normalizeEditorValves(rawValves);
    if (!valves) {
        return [];
    }
    return valves.map((valve, index) => {
        const id = valve.id ?? index;
        return {
            label: `[${formatValveNumber(id)}] ${valve.name || 'unnamed'}`,
            value: id,
        };
    });
}

export function getValveEditorFields(rawValves: unknown, rawValveId: unknown): ValveEditorFields | undefined {
    const valves = normalizeEditorValves(rawValves);
    const valveId = readValveId(rawValveId);
    if (!valves || valveId === undefined) {
        return undefined;
    }
    const valve = valves.find((candidate, index) => (candidate.id ?? index) === valveId);
    if (!valve) {
        return undefined;
    }
    return {
        _valveEditorName: valve.name,
        _valveEditorType: valve.type,
        _valveEditorStateId: valve.stateId,
        _valveEditorDuration: formatDuration(valve.duration),
        _valveEditorEnabled: valve.enabled,
        _valveEditorFlowRateLpm: valve.flowRateLpm,
        _valveEditorRainIndependent: valve.rainIndependent,
        _valveEditorMoistureThreshold: valve.moistureThreshold,
        _valveEditorSoilMoistureId: valve.soilMoistureId ?? '',
        _valveEditorManualDuration: formatDuration(valve.manualDuration),
        _valveEditorDays: [...valve.days].sort((a, b) => a - b).join(','),
        _valveEditorAllOffId: valve.allOffId ?? '',
    };
}

export function applyValveEditorFields(
    rawValves: unknown,
    rawValveId: unknown,
    rawFields: unknown,
): ValveEditorApplyResult {
    const valves = normalizeEditorValves(rawValves);
    const valveId = readValveId(rawValveId);
    if (valveId === undefined) {
        return { error: 'noValveSelected' };
    }
    if (!valves) {
        return { error: 'valveNotFound' };
    }
    const valveIndex = valves.findIndex((valve, index) => (valve.id ?? index) === valveId);
    if (valveIndex < 0) {
        return { error: 'valveNotFound' };
    }

    const fields = rawFields as Partial<ValveEditorFields>;
    const name = readTrimmedString(fields._valveEditorName);
    const type = fields._valveEditorType;
    const stateId = readTrimmedString(fields._valveEditorStateId);
    const soilMoistureId = readTrimmedString(fields._valveEditorSoilMoistureId);
    const allOffId = readTrimmedString(fields._valveEditorAllOffId);
    const duration = parseEditorDuration(fields._valveEditorDuration);
    const manualDuration = parseEditorDuration(fields._valveEditorManualDuration);
    const days = parseEditorDays(fields._valveEditorDays);
    const flowRateLpm = fields._valveEditorFlowRateLpm;
    const moistureThreshold = fields._valveEditorMoistureThreshold;

    if (duration === undefined || manualDuration === undefined) {
        return { error: 'invalidDuration' };
    }
    if (days === undefined) {
        return { error: 'invalidDays' };
    }
    if (
        typeof flowRateLpm !== 'number' ||
        !Number.isFinite(flowRateLpm) ||
        flowRateLpm < 0 ||
        typeof moistureThreshold !== 'number' ||
        !Number.isFinite(moistureThreshold) ||
        moistureThreshold < 0 ||
        moistureThreshold > 100
    ) {
        return { error: 'invalidNumbers' };
    }
    if (
        name === undefined ||
        stateId === undefined ||
        soilMoistureId === undefined ||
        allOffId === undefined ||
        !isValveType(type) ||
        typeof fields._valveEditorEnabled !== 'boolean' ||
        typeof fields._valveEditorRainIndependent !== 'boolean'
    ) {
        return { error: 'valveNotFound' };
    }

    const updatedValve: IValveConfig = {
        ...valves[valveIndex],
        name,
        type,
        stateId,
        allOffId: allOffId || undefined,
        duration,
        enabled: fields._valveEditorEnabled,
        flowRateLpm,
        rainIndependent: fields._valveEditorRainIndependent,
        moistureThreshold,
        soilMoistureId: soilMoistureId || undefined,
        manualDuration,
        days,
    };
    return { valves: valves.map((valve, index) => (index === valveIndex ? updatedValve : valve)) };
}
