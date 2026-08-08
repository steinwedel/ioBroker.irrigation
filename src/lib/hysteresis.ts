/**
 * Shared "over limit -> debounced resume" decision logic, used by both
 * WindMonitor (wind.ts) and SensorManager's rain pause (sensors.ts). Both
 * previously reimplemented this same algorithm independently; extracting it
 * here means a future behavioral fix (e.g. an edge case in the elapsed-time
 * comparison) only needs to be made once, instead of risking wind and rain
 * pause silently diverging from each other over time.
 *
 * Once `overLimit` is true, the result pauses immediately. Once it goes
 * false, the result only flips back to not-paused after `overLimit` has
 * stayed false continuously for `hysteresisMs` - avoiding rapid pause/resume
 * flapping for a signal that toggles quickly (gusty wind, a tipping-bucket
 * rain sensor, etc.).
 */
export interface HysteresisPauseState {
    /** True while `overLimit` is true, or the hysteresis has not elapsed yet */
    paused: boolean;
    /** Timestamp (ms) since `overLimit` first became false, or null while `overLimit` is true */
    belowSinceMs: number | null;
}

/**
 * @param params
 * @param params.overLimit Current raw "should pause" signal (e.g. wind over its limit, or rain detected).
 * @param params.belowSinceMs Previous `belowSinceMs` from the last evaluation (state carried between calls).
 * @param params.nowMs Current timestamp in ms.
 * @param params.hysteresisMs Minimum time in ms that `overLimit` must stay false before resuming.
 */
export function evaluateHysteresisPause(params: {
    overLimit: boolean;
    belowSinceMs: number | null;
    nowMs: number;
    hysteresisMs: number;
}): HysteresisPauseState {
    const { overLimit, belowSinceMs, nowMs, hysteresisMs } = params;
    if (overLimit) {
        return { paused: true, belowSinceMs: null };
    }
    const effectiveBelowSinceMs = belowSinceMs ?? nowMs;
    const elapsedMs = nowMs - effectiveBelowSinceMs;
    return { paused: elapsedMs < hysteresisMs, belowSinceMs: effectiveBelowSinceMs };
}

/**
 * Converts a user-configured hysteresis duration in minutes to milliseconds,
 * defaulting to 10 minutes and clamping to non-negative when the configured
 * value is missing or not a finite number (e.g. an old config predating the
 * field, or a corrupted/manually-edited value).
 *
 * @param minutes
 */
export function hysteresisMinutesToMs(minutes: number): number {
    return Math.max(0, Number.isFinite(minutes) ? minutes : 10) * 60_000;
}
