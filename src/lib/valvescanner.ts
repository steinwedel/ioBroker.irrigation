import type { IValveConfig, ScanType } from './types';

export interface ScanResult {
    valves: IValveConfig[];
    errors: string[];
}

const VALVE_DEFAULTS = {
    enabled: true,
    flowRateLpm: 0,
    duration: 600,
    rainIndependent: false,
    moistureThreshold: 0,
    manualDuration: 600,
    days: [] as number[],
};

/** Callback invoked with a short human-readable status while a scan is in progress. */
export type ScanProgressCallback = (message: string) => void;

/**
 * Extracts a display string from a name that may be a plain string or a per-language object.
 *
 * @param name
 * @param fallback
 */
function nameToString(name: ioBroker.StringOrTranslated | undefined, fallback: string): string {
    if (!name) {
        return fallback;
    }
    if (typeof name === 'string') {
        return name;
    }
    return name.de ?? name.en ?? fallback;
}

/**
 * Lists all existing instance namespaces (e.g. "rainbird.0", "rainbird.1") for
 * the given adapter name.
 *
 * @param adapter
 * @param adapterName
 */
async function findAdapterInstances(adapter: ioBroker.Adapter, adapterName: string): Promise<string[]> {
    const instanceObjects = await adapter.getForeignObjectsAsync(`system.adapter.${adapterName}.*`, 'instance');
    return Object.keys(instanceObjects)
        .filter(id => /^system\.adapter\.[^.]+\.\d+$/.test(id))
        .map(id => id.replace(/^system\.adapter\./, ''));
}

/**
 * Auto-discovery for Gardena, Homematic and Rainbird valves via object-tree
 * scanning. See plan section "Auto-Discovery (Detail)".
 *
 * Homematic discovery looks up the "Bewässerung" function enum
 * (enum.functions.*), which is global to the ioBroker installation. If an
 * adapter instance is given, only enum members belonging to that instance
 * are kept; otherwise members from all Homematic (or any other) instances
 * are scanned.
 *
 * @param adapter
 * @param type
 * @param instance
 * @param locationId
 */
/**
 * Adapter names that must never be selectable/scanned as an auto-discovery
 * instance, and whose members are always excluded from the "Generic"/"All"
 * function-enum scan. Besides this irrigation adapter itself and admin, the
 * "alias" adapter is excluded: alias objects are virtual references to real
 * states elsewhere, so scanning them would either duplicate a valve already
 * found under its real adapter or pick up a non-irrigation alias by mistake.
 */
const FORBIDDEN_SCAN_ADAPTERS = ['admin', 'irrigation', 'alias'];

/**
 * Adapter names already covered by a dedicated scan (Gardena/Rainbird/Homematic).
 * The "Generic" scan skips members belonging to these adapters, since they are
 * found via their own specialized discovery (which also looks at data points
 * other than a simple on/off switch, e.g. Gardena's duration_value).
 */
const SPECIALIZED_SCAN_ADAPTERS = ['smartgarden', 'rainbird', 'hm-rpc', 'hydrawise'];

export async function scanForValves(
    adapter: ioBroker.Adapter,
    type: ScanType,
    instance: string,
    locationId?: string,
    onProgress?: ScanProgressCallback,
): Promise<ScanResult> {
    if (type === 'All') {
        adapter.log.debug('Valve scan: type=All - running Gardena, Rainbird, Homematic, Hydrawise and Generic scans');
        const steps: ScanType[] = ['Gardena', 'Rainbird', 'Homematic', 'Hydrawise', 'Generic'];
        const valves: IValveConfig[] = [];
        const errors: string[] = [];
        for (const step of steps) {
            onProgress?.(`Scanning ${step}...`);
            const stepResult = await scanForValves(adapter, step, '', locationId);
            valves.push(...stepResult.valves);
            errors.push(...stepResult.errors);
        }
        return { valves, errors };
    }

    const namespace = instance.replace(/^system\.adapter\./, '');
    adapter.log.debug(
        `Valve scan: type=${type} instance="${instance}" namespace="${namespace}" locationId="${locationId ?? ''}"`,
    );
    const adapterName = namespace.split('.')[0];
    if (namespace && FORBIDDEN_SCAN_ADAPTERS.includes(adapterName)) {
        return { valves: [], errors: [`Scanning the "${adapterName}" instance is not allowed.`] };
    }
    if (type === 'Generic' && namespace && SPECIALIZED_SCAN_ADAPTERS.includes(adapterName)) {
        return {
            valves: [],
            errors: [`The "${adapterName}" adapter has a dedicated scan type, use that instead of "Generic".`],
        };
    }
    switch (type) {
        case 'Gardena':
            return scanGardena(adapter, namespace, locationId ?? '');
        case 'Homematic':
            return scanHomematic(adapter, namespace || undefined);
        case 'Rainbird':
            return scanRainbird(adapter, namespace);
        case 'Hydrawise':
            return scanHydrawise(adapter, namespace);
        case 'Generic':
            return scanGeneric(adapter, namespace || undefined);
        default:
            return { valves: [], errors: [`Auto-discovery not supported for type "${String(type)}"`] };
    }
}

/**
 * Extracts the human-readable valve name from a `name_value` state.
 * The state value is normally a plain string (e.g. "WohnZ Beet"), but some
 * smartgarden versions store a JSON payload like `{"name":{"value":"WohnZ Beet"}}`.
 *
 * @param val
 * @param fallback
 */
function extractGardenaName(val: unknown, fallback: string): string {
    if (typeof val !== 'string' || !val) {
        return fallback;
    }
    const trimmed = val.trim();
    if (!trimmed.startsWith('{')) {
        return trimmed;
    }
    try {
        const parsed = JSON.parse(trimmed) as { name?: { value?: unknown } };
        if (parsed?.name?.value && typeof parsed.name.value === 'string') {
            return parsed.name.value;
        }
    } catch {
        // not JSON, fall through
    }
    return trimmed;
}

/**
 * Gardena's default/placeholder valve name for an output that was never
 * renamed by the user (e.g. an unused/unconnected valve port on the
 * controller), in the form "Valve 1", "Valve 2", etc. Such valves are
 * skipped during discovery - see README "Known limitations" section.
 *
 * @param name
 */
function isGardenaPlaceholderName(name: string): boolean {
    return /^valve\s+\d+$/i.test(name.trim());
}

/**
 * Auto-discovery for Gardena valves. If `instance` is empty, all existing
 * "smartgarden.X" instances are scanned.
 *
 * @param adapter
 * @param instance Adapter instance namespace, e.g. "smartgarden.0". Empty string scans all smartgarden instances.
 * @param locationId
 */
async function scanGardena(adapter: ioBroker.Adapter, instance: string, locationId: string): Promise<ScanResult> {
    const errors: string[] = [];
    const valves: IValveConfig[] = [];
    try {
        const instances = instance ? [instance] : await findAdapterInstances(adapter, 'smartgarden');
        adapter.log.debug(
            `Gardena scan: scanning instance(s) ${instances.length ? instances.join(', ') : '(none found)'}`,
        );

        for (const inst of instances) {
            const prefix = locationId ? `${inst}.${locationId}.` : `${inst}.`;

            const [durStates, stopStates] = await Promise.all([
                adapter.getForeignObjectsAsync(`${prefix}*.SERVICE_VALVE_*.duration_value`, 'state'),
                adapter.getForeignObjectsAsync(`${prefix}*.SERVICE_VALVE_SET_*.stop_all_valves_i`, 'state'),
            ]);

            adapter.log.debug(
                `Gardena scan: instance="${inst}" durationStates=${Object.keys(durStates).length} stopStates=${Object.keys(stopStates).length}`,
            );

            const stopLookup = new Set(Object.keys(stopStates));
            const durEntries = Object.entries(durStates);

            const nameStates = await Promise.all(
                durEntries.map(([id]) => {
                    const nameStateId = `${id.slice(0, -'.duration_value'.length)}.name_value`;
                    return adapter.getForeignStateAsync(nameStateId).catch(() => null);
                }),
            );

            let skippedPlaceholders = 0;
            durEntries.forEach(([id], index) => {
                const basePath = id.slice(0, -'.duration_value'.length);
                const stopId = id.replace(
                    /\.DEVICE_([^.]+)\.SERVICE_VALVE_\1-.+?\.duration_value$/,
                    '.DEVICE_$1.SERVICE_VALVE_SET_$1.stop_all_valves_i',
                );

                const name = extractGardenaName(nameStates[index]?.val, basePath);
                if (isGardenaPlaceholderName(name)) {
                    skippedPlaceholders++;
                    return;
                }

                valves.push({
                    name,
                    type: 'Gardena',
                    stateId: id,
                    allOffId: stopLookup.has(stopId) ? stopId : undefined,
                    ...VALVE_DEFAULTS,
                });
            });
            if (skippedPlaceholders > 0) {
                adapter.log.debug(
                    `Gardena scan: instance="${inst}" skipped ${skippedPlaceholders} valve(s) with placeholder name (e.g. "Valve 1")`,
                );
            }
        }

        adapter.log.debug(`Gardena scan: valves found=${valves.length} errors=${errors.length}`);
    } catch (error) {
        adapter.log.error(`Gardena scan failed: ${(error as Error).message}`);
        errors.push(`Gardena scan failed: ${(error as Error).message}`);
    }
    return { valves, errors };
}

/**
 * Function names (case-insensitive, any configured language) that identify the
 * irrigation function enum in enum.functions.*.
 */
const IRRIGATION_FUNCTION_NAMES = ['bewässerung', 'irrigation'];

/**
 * Finds the `enum.functions.*` object(s) whose display name matches
 * "Bewässerung" or "Irrigation" (case-insensitive, across all configured
 * languages), and merges their members into a single result.
 *
 * ioBroker installations can end up with two such enums at once: the
 * standard `enum.functions.irrigation` created by the admin adapter/setup
 * (often left with empty `members`), and a separately/manually created one
 * such as `enum.functions.Bewässerung` that actually holds the assigned
 * Homematic devices. Returning only the first match found (in whatever
 * order the backend happens to return `enum.functions.*` in - not
 * necessarily alphabetical) could silently return the empty one and make
 * discovery find 0 valves even though matching devices exist under the
 * other enum. Merging avoids depending on that order and also covers the
 * case where a user's devices are split across both enums.
 *
 * @param adapter
 */
async function findIrrigationFunctionEnum(adapter: ioBroker.Adapter): Promise<ioBroker.EnumObject | null> {
    const enums = await adapter.getForeignObjectsAsync('enum.functions.*', 'enum');
    const matches: ioBroker.EnumObject[] = [];
    for (const enumObj of Object.values(enums)) {
        const name = enumObj?.common?.name;
        const candidates = typeof name === 'string' ? [name] : Object.values(name ?? {});
        if (
            candidates.some(
                candidate =>
                    typeof candidate === 'string' && IRRIGATION_FUNCTION_NAMES.includes(candidate.toLowerCase()),
            )
        ) {
            matches.push(enumObj);
        }
    }

    if (matches.length === 0) {
        return null;
    }
    if (matches.length === 1) {
        return matches[0];
    }

    adapter.log.debug(
        `Found ${matches.length} irrigation function enums (${matches.map(e => e._id).join(', ')}) - merging their members`,
    );
    const mergedMembers = [...new Set(matches.flatMap(e => e.common?.members ?? []))];
    return {
        ...matches[0],
        _id: matches.map(e => e._id).join('+'),
        common: { ...matches[0].common, members: mergedMembers },
    };
}

/**
 * Auto-discovery for Homematic valves: finds all members of the "Bewässerung"
 * (irrigation) function enum, then keeps those that have a `.STATE` child with
 * `type: "state"` and `common.role: "switch"`. If `instance` is given (e.g.
 * "hm-rpc.1"), only members belonging to that adapter instance are kept.
 *
 * @param adapter
 * @param instance Adapter instance namespace to restrict the scan to, e.g. "hm-rpc.1".
 */
async function scanHomematic(adapter: ioBroker.Adapter, instance?: string): Promise<ScanResult> {
    const errors: string[] = [];
    const valves: IValveConfig[] = [];
    try {
        const functionEnum = await findIrrigationFunctionEnum(adapter);
        if (!functionEnum) {
            errors.push('No "Bewässerung"/"Irrigation" function enum found (enum.functions.*)');
            return { valves, errors };
        }

        const allMembers = functionEnum.common?.members ?? [];
        const members = instance ? allMembers.filter(memberId => memberId.startsWith(`${instance}.`)) : allMembers;
        adapter.log.debug(
            `Homematic scan: function enum "${functionEnum._id}" has ${allMembers.length} member(s), ` +
                `${members.length} match instance filter "${instance ?? '(none)'}"`,
        );

        const stateIds = members.map(memberId => `${memberId}.STATE`);
        const [stateObjects, memberObjects] = await Promise.all([
            Promise.all(stateIds.map(id => adapter.getForeignObjectAsync(id).catch(() => null))),
            Promise.all(members.map(id => adapter.getForeignObjectAsync(id).catch(() => null))),
        ]);

        members.forEach((memberId, index) => {
            const stateObj = stateObjects[index];
            if (!stateObj || stateObj.type !== 'state' || stateObj.common?.role !== 'switch') {
                return;
            }

            const memberObj = memberObjects[index];
            valves.push({
                name: nameToString(memberObj?.common?.name, memberId),
                type: 'Homematic',
                stateId: memberId,
                ...VALVE_DEFAULTS,
            });
        });

        adapter.log.debug(`Homematic scan: valves found=${valves.length} errors=${errors.length}`);
    } catch (error) {
        adapter.log.error(`Homematic scan failed: ${(error as Error).message}`);
        errors.push(`Homematic scan failed: ${(error as Error).message}`);
    }
    return { valves, errors };
}

/**
 * Auto-discovery for Rainbird valves. If `instance` is empty, all existing
 * "rainbird.X" instances are scanned.
 *
 * @param adapter
 * @param instance Adapter instance namespace, e.g. "rainbird.0". Empty string scans all rainbird instances.
 */
async function scanRainbird(adapter: ioBroker.Adapter, instance: string): Promise<ScanResult> {
    const errors: string[] = [];
    const valves: IValveConfig[] = [];
    try {
        const instances = instance ? [instance] : await findAdapterInstances(adapter, 'rainbird');
        for (const inst of instances) {
            const objects = await adapter.getForeignObjectsAsync(`${inst}.device.stations.*`, 'state');
            const stopId = `${inst}.device.commands.stopIrrigation`;
            const stopExists = await adapter.getForeignObjectAsync(stopId).catch(() => null);
            if (!stopExists) {
                // Rainbird has no per-zone stop command, only the controller-wide
                // `allOffId` ("stopIrrigation"). Without it the adapter can never
                // reliably stop a Rainbird zone once started - warn loudly so this is
                // not discovered only later, when a stop() silently cannot verify it.
                adapter.log.warn(
                    `Rainbird scan: instance="${inst}" has no "${stopId}" state - valves discovered on this ` +
                        'instance will be created without allOffId and cannot be reliably stopped by the adapter.',
                );
            }
            const runZoneIds = Object.keys(objects).filter(id => id.endsWith('.runZone'));
            for (const runZoneId of runZoneIds) {
                const basePath = runZoneId.slice(0, -'.runZone'.length);
                const stationMatch = /stations\.(\d+)/.exec(basePath);
                const stationNum = stationMatch ? stationMatch[1] : basePath;
                valves.push({
                    name: `Station ${stationNum}`,
                    type: 'Rainbird',
                    stateId: basePath,
                    allOffId: stopExists ? stopId : undefined,
                    ...VALVE_DEFAULTS,
                });
            }
        }
    } catch (error) {
        errors.push(`Rainbird scan failed: ${(error as Error).message}`);
    }
    return { valves, errors };
}

async function scanHydrawise(adapter: ioBroker.Adapter, instance: string): Promise<ScanResult> {
    const errors: string[] = [];
    const valves: IValveConfig[] = [];
    try {
        const instances = instance ? [instance] : await findAdapterInstances(adapter, 'hydrawise');
        for (const inst of instances) {
            const runZoneStates = await adapter.getForeignObjectsAsync(`${inst}.schedule.*.runZone`, 'state');
            const entries = Object.entries(runZoneStates);
            const zoneObjects = await Promise.all(
                entries.map(([id]) => adapter.getForeignObjectAsync(id.slice(0, -'.runZone'.length)).catch(() => null)),
            );
            entries.forEach(([id], index) => {
                const basePath = id.slice(0, -'.runZone'.length);
                valves.push({
                    name: nameToString(zoneObjects[index]?.common?.name, basePath),
                    type: 'Hydrawise',
                    stateId: id,
                    ...VALVE_DEFAULTS,
                });
            });
        }
    } catch (error) {
        errors.push(`Hydrawise scan failed: ${(error as Error).message}`);
    }
    return { valves, errors };
}

/**
 * Checks whether the given object itself is a switch state
 * (`type: "state"`, `common.role: "switch"`).
 *
 * @param obj
 */
function isSwitchState(obj: ioBroker.Object | null | undefined): boolean {
    return !!obj && obj.type === 'state' && obj.common?.role === 'switch';
}

/**
 * Auto-discovery for any adapter not covered by a dedicated scan (Gardena,
 * Rainbird, Homematic): finds all members of the "Bewässerung"/"Irrigation"
 * function enum, then keeps those that are themselves a switch state, or -
 * for members that are a channel/device (e.g. Homematic-style datapoints) -
 * have a `.STATE` child that is a switch state.
 *
 * Members belonging to adapters that already have a dedicated/specialized
 * scan (smartgarden, rainbird, hm-rpc) are skipped, since those are found via
 * their own discovery which also inspects type-specific data points beyond a
 * simple on/off switch. The irrigation adapter's own instance and the admin
 * adapter are always excluded (enforced again in scanForValves).
 *
 * @param adapter
 * @param instance Adapter instance namespace to restrict the scan to, e.g. "shelly.0". Omit to scan all instances.
 */
async function scanGeneric(adapter: ioBroker.Adapter, instance?: string): Promise<ScanResult> {
    const errors: string[] = [];
    const valves: IValveConfig[] = [];
    try {
        const functionEnum = await findIrrigationFunctionEnum(adapter);
        if (!functionEnum) {
            errors.push('No "Bewässerung"/"Irrigation" function enum found (enum.functions.*)');
            return { valves, errors };
        }

        const allMembers = functionEnum.common?.members ?? [];
        const members = allMembers.filter(memberId => {
            const adapterName = memberId.replace(/^system\.adapter\./, '').split('.')[0];
            if (FORBIDDEN_SCAN_ADAPTERS.includes(adapterName) || SPECIALIZED_SCAN_ADAPTERS.includes(adapterName)) {
                return false;
            }
            return instance ? memberId.startsWith(`${instance}.`) : true;
        });
        adapter.log.debug(
            `Generic scan: function enum "${functionEnum._id}" has ${allMembers.length} member(s), ` +
                `${members.length} after excluding specialized/forbidden adapters and applying instance filter "${instance ?? '(none)'}"`,
        );

        const [memberObjects, memberStateObjects] = await Promise.all([
            Promise.all(members.map(id => adapter.getForeignObjectAsync(id).catch(() => null))),
            Promise.all(members.map(id => adapter.getForeignObjectAsync(`${id}.STATE`).catch(() => null))),
        ]);

        members.forEach((memberId, index) => {
            const memberObj = memberObjects[index];
            let stateId: string;
            if (isSwitchState(memberObj)) {
                stateId = memberId;
            } else if (isSwitchState(memberStateObjects[index])) {
                stateId = `${memberId}.STATE`;
            } else {
                return;
            }

            valves.push({
                name: nameToString(memberObj?.common?.name, memberId),
                type: 'Generic',
                stateId,
                ...VALVE_DEFAULTS,
            });
        });

        adapter.log.debug(`Generic scan: valves found=${valves.length} errors=${errors.length}`);
    } catch (error) {
        adapter.log.error(`Generic scan failed: ${(error as Error).message}`);
        errors.push(`Generic scan failed: ${(error as Error).message}`);
    }
    return { valves, errors };
}
