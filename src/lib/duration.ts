/**
 * Parses a duration value into seconds.
 *
 * `fallback` is only used when *no* value was actually provided (undefined,
 * null, or a non-numeric/malformed string, e.g. an empty string or garbage
 * input) - in that case we have no explicit user intent to go on, so the
 * configured fallback (typically 600s) is used.
 *
 * If a value *was* explicitly provided but parses to 0 or a negative number
 * of seconds (e.g. an explicit "0" or "00:00"), that is a deliberate,
 * well-formed input, not "no value" - silently replacing it with the
 * (often much longer) fallback would be surprising and has previously
 * caused unwanted long irrigation runs. Instead, such an explicit
 * zero/negative value is clamped to a minimum of 1 second rather than
 * falling back.
 *
 * @param value
 * @param fallback
 */
export function parseDuration(value: unknown, fallback = 600): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(1, Math.round(value));
    }
    if (typeof value !== 'string' || value.trim() === '') {
        return fallback;
    }

    const parts = value.trim().split(':');
    if (parts.length < 1 || parts.length > 3 || parts.some(part => !/^\d+$/.test(part))) {
        return fallback;
    }

    const values = parts.map(Number);
    let seconds: number;
    if (values.length === 1) {
        seconds = values[0] * 60;
    } else if (values.length === 2) {
        seconds = values[0] * 60 + values[1];
    } else {
        seconds = values[0] * 3600 + values[1] * 60 + values[2];
    }
    // The string was explicitly provided and well-formed - clamp explicit
    // zero/negative results to a minimum of 1s rather than silently
    // substituting the (often much longer) fallback duration.
    return seconds > 0 ? seconds : 1;
}

export function formatDuration(seconds: number): string {
    const value = Math.max(0, Math.round(seconds));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remainingSeconds = value % 60;
    const formattedMinutes = String(minutes).padStart(2, '0');
    const formattedSeconds = String(remainingSeconds).padStart(2, '0');

    return hours > 0
        ? `${String(hours).padStart(2, '0')}:${formattedMinutes}:${formattedSeconds}`
        : `${formattedMinutes}:${formattedSeconds}`;
}
