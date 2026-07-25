export function parseDuration(value: unknown, fallback = 600): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(1, Math.round(value));
    }
    if (typeof value !== 'string') {
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
    return seconds > 0 ? seconds : fallback;
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
