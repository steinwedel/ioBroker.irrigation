/**
 * Smartgarden API Rate Limiter
 *
 * Enforces two sliding-window limits plus a minimum inter-request gap to
 * stay below the Husqvarna/Gardena API rate limits, with one slot of safety
 * margin per window to account for the smartgarden adapter's own API calls
 * (token refresh, WebSocket reconnect) that the irrigation adapter cannot
 * control.
 *
 * API limits:         10 req / 10s,  700 req / 7d
 * Enforced as:         9 req / 10s,  699 req / 7d
 *
 * Additionally enforces a minimum interval between any two requests (1 s)
 * to prevent parallel bursts that can trigger 504 Gateway Timeout on the
 * Gardena API side.
 *
 * Queued entries are keyed by valve id. When a new acquire() for the same
 * key arrives while the old one is still waiting, the old entry is cancelled
 * and replaced — a pending start superseded by a stop wastes no API call.
 *
 * 10s window → delay (max ~10s wait, acceptable)
 * 7d window  → throw Error (waiting up to 7 days is pointless)
 */

const LIMIT_10S = 9;
const WINDOW_10S_MS = 10_000;

const LIMIT_7D = 699;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1_000;

/** Minimum interval between any two API requests to avoid 504 bursts. */
const MIN_INTERVAL_MS = 1_000;

export interface RateLimiterState {
    window10sCount: number;
    weeklyCount: number;
    lastRequest: number;
    nextSlot: number;
    queueLength: number;
}

export class CancelledError extends Error {
    public constructor() {
        super('Rate-limited request cancelled (superseded by newer command)');
        this.name = 'CancelledError';
    }
}

interface QueueEntry {
    key: string;
    resolve: () => void;
    reject: (error: CancelledError) => void;
}

export class RateLimiter {
    private timestamps10s: number[] = [];
    private timestamps7d: number[] = [];
    private pendingQueue: QueueEntry[] = [];
    private processing = false;
    private lastRequestTime = 0;

    /**
     * Acquires a rate-limit slot. If the 10s window is full the call is
     * delayed until the oldest timestamp leaves the window. If the 7d window
     * is exhausted an error is thrown.
     *
     * When a queued entry for `key` already exists it is cancelled and
     * replaced — a newer command for the same valve renders the old one
     * obsolete.
     *
     * All requests are spaced by at least MIN_INTERVAL_MS to prevent
     * parallel bursts reaching the Gardena API simultaneously.
     *
     * @param key Unique identifier for the caller (valve id), used for cancellation
     */
    public async acquire(key: string): Promise<void> {
        const now = Date.now();
        this.prune(now);

        if (this.timestamps7d.length >= LIMIT_7D) {
            throw new Error(
                `Smartgarden rate limit exhausted: ${this.timestamps7d.length}/${LIMIT_7D} requests in the last 7 days`,
            );
        }

        if (this.timestamps10s.length >= LIMIT_10S) {
            this.cancelKey(key);
            await this.enqueue(key);
            return;
        }

        this.cancelKey(key);
        await this.waitForMinInterval();
        const ts = Date.now();
        this.timestamps10s.push(ts);
        this.timestamps7d.push(ts);
        this.lastRequestTime = ts;
    }

    /**
     * Prunes expired timestamps from both windows.
     *
     * @param now
     */
    private prune(now: number): void {
        const cutoff10s = now - WINDOW_10S_MS;
        while (this.timestamps10s.length > 0 && this.timestamps10s[0] <= cutoff10s) {
            this.timestamps10s.shift();
        }

        const cutoff7d = now - WINDOW_7D_MS;
        while (this.timestamps7d.length > 0 && this.timestamps7d[0] <= cutoff7d) {
            this.timestamps7d.shift();
        }
    }

    /**
     * Waits until at least MIN_INTERVAL_MS has passed since the last
     * recorded request.
     */
    private async waitForMinInterval(): Promise<void> {
        const gap = this.lastRequestTime + MIN_INTERVAL_MS - Date.now();
        if (gap > 0) {
            await new Promise(r => setTimeout(r, gap));
        }
    }

    /**
     * Removes any queued entry with the given key, rejecting it with
     * CancelledError so the caller can abort cleanly.
     *
     * @param key
     */
    private cancelKey(key: string): void {
        const idx = this.pendingQueue.findIndex(e => e.key === key);
        if (idx >= 0) {
            const [entry] = this.pendingQueue.splice(idx, 1);
            entry.reject(new CancelledError());
        }
    }

    /**
     * Enqueues the caller and waits for the next available 10s-window slot.
     * Only one enqueued caller runs the drain loop at a time; subsequent
     * callers wait for their own resolve.
     *
     * @param key
     */
    private enqueue(key: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.pendingQueue.push({ key, resolve, reject });
            if (!this.processing) {
                this.processing = true;
                void this.drain();
            }
        });
    }

    private async drain(): Promise<void> {
        while (this.pendingQueue.length > 0) {
            const now = Date.now();
            this.prune(now);

            if (this.timestamps10s.length < LIMIT_10S) {
                await this.waitForMinInterval();
                const entry = this.pendingQueue.shift();
                if (entry) {
                    const ts = Date.now();
                    this.timestamps10s.push(ts);
                    this.timestamps7d.push(ts);
                    this.lastRequestTime = ts;
                    entry.resolve();
                }
                continue;
            }

            const oldest = this.timestamps10s[0];
            const delay = oldest + WINDOW_10S_MS - Date.now() + 50;
            if (delay > 0) {
                await new Promise(r => setTimeout(r, delay));
            }
        }
        this.processing = false;
    }

    /**
     * Returns the current limiter state for monitoring.
     */
    public getState(): RateLimiterState {
        const now = Date.now();
        this.prune(now);
        let nextSlot = 0;
        if (this.timestamps10s.length >= LIMIT_10S) {
            nextSlot = this.timestamps10s[0] + WINDOW_10S_MS;
        } else {
            nextSlot = Math.max(Date.now(), this.lastRequestTime + MIN_INTERVAL_MS);
        }
        return {
            window10sCount: this.timestamps10s.length,
            weeklyCount: this.timestamps7d.length,
            lastRequest: this.timestamps10s.length > 0 ? this.timestamps10s[this.timestamps10s.length - 1] : 0,
            nextSlot,
            queueLength: this.pendingQueue.length,
        };
    }
}
