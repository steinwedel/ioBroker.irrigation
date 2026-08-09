import type { IrrigationNativeConfig } from './types';

export interface SchedulerDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
    onTrigger: (planName: string, source: 'timer' | 'ical') => Promise<void>;
    isFrostBlocked: () => boolean;
    isSeasonBlocked: () => boolean;
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Handles the configurable "HH:MM" timers and the ical calendar trigger.
 * See plan section "iCal-Trigger" and "Saison-Pause"/"Frostschutz".
 */
export class Scheduler {
    private readonly deps: SchedulerDeps;
    private timerHandles: ReturnType<ioBroker.Adapter['setInterval']>[] = [];
    private lastCheckedMinute = -1;
    private icalTriggerSubscribed = false;

    public constructor(deps: SchedulerDeps) {
        this.deps = deps;
    }

    public async init(): Promise<void> {
        // Use a single 1s ticking check instead of per-time schedule() calls so that
        // changes to timerTimes (a runtime array) take effect immediately without
        // re-registering OS-level cron jobs.
        const handle = this.deps.adapter.setInterval(() => {
            this.checkTimers().catch(error =>
                this.deps.adapter.log.error(`Scheduler tick failed: ${(error as Error).message}`),
            );
        }, 1000);
        this.timerHandles.push(handle);

        // "Timer times" and the iCal trigger are mutually exclusive alternatives
        // (see ISchedulerConfig.triggerMode doc comment) - only subscribe to the
        // iCal trigger state when it is actually the active mode, so a state change
        // on a stale/leftover icalTriggerState from a previous "ical" configuration
        // can never fire a run while "timer" mode is selected.
        const config = this.deps.getConfig();
        const icalState = config.scheduler.icalTriggerState;
        if (config.scheduler.triggerMode === 'ical' && icalState) {
            await this.deps.adapter.subscribeForeignStatesAsync(icalState);
            this.icalTriggerSubscribed = true;
        }
    }

    public destroy(): void {
        for (const handle of this.timerHandles) {
            this.deps.adapter.clearInterval(handle);
        }
        this.timerHandles = [];
    }

    private async checkTimers(): Promise<void> {
        const now = new Date();
        const minuteKey = now.getHours() * 60 + now.getMinutes();
        if (minuteKey === this.lastCheckedMinute) {
            return;
        }
        this.lastCheckedMinute = minuteKey;

        const config = this.deps.getConfig();
        if (!config.scheduler.autoMode || config.scheduler.triggerMode !== 'timer') {
            return;
        }
        // Season-based automation only applies to the fixed-time timer trigger, not
        // to iCal-triggered runs (see ISchedulerConfig.triggerMode doc comment) -
        // isSeasonBlocked() is therefore only ever checked here, never in
        // onForeignStateChange()'s iCal path below.
        if (this.deps.isSeasonBlocked() || this.deps.isFrostBlocked()) {
            return;
        }

        const nowStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
        for (const timeStr of config.scheduler.timerTimes) {
            if (!TIME_RE.test(timeStr.trim())) {
                continue;
            }
            if (normalizeTime(timeStr) === normalizeTime(nowStr)) {
                const planName = config.plans[0]?.name ?? 'All';
                await this.deps.onTrigger(planName, 'timer');
            }
        }
    }

    /**
     * Called from main.ts's onStateChange for foreign state subscriptions.
     * Resolves the plan name from the ical event title, defaulting to the
     * configured prefix's plan if no specific plan name is found in the title.
     *
     * @param id
     * @param state
     */
    public async onForeignStateChange(id: string, state: ioBroker.State | null | undefined): Promise<boolean> {
        const config = this.deps.getConfig();
        if (config.scheduler.triggerMode !== 'ical' || id !== config.scheduler.icalTriggerState) {
            return false;
        }
        if (state?.val !== true) {
            return true;
        }

        // Season-based automation is timer-only (see checkTimers()); only frost
        // protection also blocks iCal-triggered runs.
        if (this.deps.isFrostBlocked()) {
            this.deps.adapter.log.info('iCal trigger fired but frost protection block is active - ignored.');
            return true;
        }

        const planName = config.plans[0]?.name ?? 'All';
        await this.deps.onTrigger(planName, 'ical');
        return true;
    }

    public async resubscribeIcal(newState: string): Promise<void> {
        if (this.icalTriggerSubscribed) {
            const oldState = this.deps.getConfig().scheduler.icalTriggerState;
            if (oldState) {
                await this.deps.adapter.unsubscribeForeignStatesAsync(oldState);
            }
        }
        if (newState) {
            await this.deps.adapter.subscribeForeignStatesAsync(newState);
            this.icalTriggerSubscribed = true;
        }
    }
}

function normalizeTime(value: string): string {
    const match = TIME_RE.exec(value.trim());
    if (!match) {
        return value.trim();
    }
    return `${parseInt(match[1], 10)}:${match[2]}`;
}

/**
 * Converts a valid "HH:MM"/"H:MM" string to minutes since midnight, or
 * `Number.POSITIVE_INFINITY` for anything that doesn't match `TIME_RE`, so
 * unparsable entries always sort last rather than throwing or corrupting the
 * order of the valid entries around them.
 *
 * @param value
 */
function timeStringToMinutes(value: string): number {
    const match = TIME_RE.exec(value.trim());
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

/**
 * Returns a new array with `timerTimes` sorted in ascending time-of-day
 * order (not lexicographic string order, so e.g. "6:30" sorts before
 * "21:30" despite "2" < "6" as characters). Used both by the admin UI's
 * live chip-input re-sort (see admin/jsonConfig.json's onChange.calculateFunc
 * on "scheduler.timerTimes", which duplicates this exact comparison in a
 * JS-expression string since it must run client-side without access to this
 * module) and by main.ts's onReady() self-heal for already-saved,
 * out-of-order config values that predate that admin UI live-sort fix (the
 * live-sort only re-sorts on the next add/remove of a chip in an *already
 * open* config dialog - it does not retroactively fix a value that was saved
 * out of order before the fix existed, or entered directly via the Objects
 * tab / a script).
 *
 * @param timerTimes
 */
export function sortTimerTimes(timerTimes: string[]): string[] {
    return [...timerTimes].sort((a, b) => timeStringToMinutes(a) - timeStringToMinutes(b));
}

/**
 * Extracts a plan name from an ical event title like "Bewässerung: Rasen", see plan iCal-Trigger rule.
 *
 * @param title
 * @param prefix
 * @param planNames
 * @param defaultPlan
 */
export function resolvePlanFromIcalTitle(
    title: string,
    prefix: string,
    planNames: string[],
    defaultPlan: string,
): string {
    const trimmed = title.trim();
    const prefixLower = prefix.toLowerCase();
    if (!trimmed.toLowerCase().startsWith(prefixLower)) {
        return defaultPlan;
    }

    let rest = trimmed.substring(prefix.length).trim();
    rest = rest.replace(/^[:\-–]\s*/, '').trim();
    if (!rest) {
        return defaultPlan;
    }

    const match = planNames.find(name => name.toLowerCase() === rest.toLowerCase());
    return match ?? defaultPlan;
}
