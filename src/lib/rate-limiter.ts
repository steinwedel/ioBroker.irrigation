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
 * All acquire() calls - regardless of how many valves call it concurrently -
 * are funneled through a single serialized queue (see `queue` below). This
 * is essential: valve start()/stop() calls are triggered by independent
 * event handlers (onOwnStateChange per valve, automation batches, manual
 * commands) and can genuinely run concurrently. An earlier version of this
 * limiter had a "fast path" that checked the window count and then awaited
 * waitForMinInterval() without holding any lock; two concurrent callers
 * could both observe "window not full", both compute the same wait based on
 * the same stale `lastRequestTime`, and both proceed to record a timestamp
 * and fire their HTTP request within the same MIN_INTERVAL_MS window -
 * defeating the entire point of the limiter and triggering real 429/504
 * responses from the Gardena API. Routing every call through one queue that
 * only ever admits the next entry after fully completing the previous one
 * closes that race.
 *
 * Queued entries are keyed by valve id. When a new acquire() for the same
 * key arrives while the old one is still waiting, the old entry is
 * cancelled and replaced - a pending start superseded by a stop wastes no
 * API call.
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
    reject: (error: Error) => void;
}

export class RateLimiter {
    private timestamps10s: number[] = [];
    private timestamps7d: number[] = [];
    /**
     * Every acquire() call is appended here and only ever granted a slot by
     * the single drain() loop below, one at a time - this is what makes
     * acquire() safe to call concurrently from multiple valves.
     */
    private queue: QueueEntry[] = [];
    private processing = false;
    private lastRequestTime = 0;
    private destroyed = false;
    /** Maps each in-flight sleep() timer to its resolve callback, so destroy() can settle it. */
    private activeTimers = new Map<ReturnType<typeof setTimeout>, () => void>();

    /**
     * Cancels all pending queue entries and settles any outstanding sleep()
     * timers so nothing keeps the Node.js event loop alive or leaves a
     * caller awaiting forever. Must be called from the adapter's onUnload -
     * without it, a pending acquire() still waiting in drain() holds a bare
     * (non-adapter-owned) setTimeout open, which prevents the process from
     * exiting even after the unload callback has run, causing the ioBroker
     * host to see the old process as still alive on next start
     * (ADAPTER_ALREADY_RUNNING) and get stuck restarting it.
     *
     * Resolving (rather than just clearing) each pending sleep() timer is
     * essential: clearTimeout() alone prevents the timer's callback - the
     * only place that resolves the sleep() promise - from ever firing,
     * which would leave drain() hanging forever instead of unblocking so it
     * can observe `destroyed` and cancel cleanly.
     */
    public destroy(): void {
        this.destroyed = true;
        for (const [timer, resolve] of this.activeTimers) {
            clearTimeout(timer);
            resolve();
        }
        this.activeTimers.clear();
        for (const entry of this.queue) {
            entry.reject(new CancelledError());
        }
        this.queue = [];
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.activeTimers.delete(timer);
                resolve();
            }, ms);
            this.activeTimers.set(timer, resolve);
        });
    }

    /**
     * Acquires a rate-limit slot. Every call - whether the window currently
     * has room or not - is queued and processed one at a time by drain(),
     * so concurrent callers can never race each other; see the class-level
     * comment for why that matters.
     *
     * When a queued entry for `key` already exists it is cancelled and
     * replaced - a newer command for the same valve renders the old one
     * obsolete.
     *
     * @param key Unique identifier for the caller (valve id), used for cancellation
     */
    public acquire(key: string): Promise<void> {
        if (this.destroyed) {
            return Promise.reject(new CancelledError());
        }
        this.cancelKey(key);
        return new Promise<void>((resolve, reject) => {
            this.queue.push({ key, resolve, reject });
            if (!this.processing) {
                this.processing = true;
                void this.drain();
            }
        });
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
     * Removes any queued entry with the given key, rejecting it with
     * CancelledError so the caller can abort cleanly.
     *
     * @param key
     */
    private cancelKey(key: string): void {
        const idx = this.queue.findIndex(e => e.key === key);
        if (idx >= 0) {
            const [entry] = this.queue.splice(idx, 1);
            entry.reject(new CancelledError());
        }
    }

    /**
     * Processes the queue strictly one entry at a time: for each entry it
     * waits out both the 10s-window and the minimum inter-request interval
     * before recording a timestamp and resolving that single caller, only
     * then moving on to the next entry. This serialization is what
     * guarantees no two callers can ever be admitted within the same
     * MIN_INTERVAL_MS window, regardless of how many called acquire()
     * concurrently.
     */
    private async drain(): Promise<void> {
        while (this.queue.length > 0 && !this.destroyed) {
            const now = Date.now();
            this.prune(now);

            if (this.timestamps7d.length >= LIMIT_7D) {
                const entry = this.queue.shift();
                entry?.reject(
                    new Error(
                        `Smartgarden rate limit exhausted: ${this.timestamps7d.length}/${LIMIT_7D} requests in the last 7 days`,
                    ),
                );
                continue;
            }

            if (this.timestamps10s.length >= LIMIT_10S) {
                const oldest = this.timestamps10s[0];
                const delay = oldest + WINDOW_10S_MS - Date.now() + 50;
                if (delay > 0) {
                    await this.sleep(delay);
                }
                continue;
            }

            const gap = this.lastRequestTime + MIN_INTERVAL_MS - Date.now();
            if (gap > 0) {
                await this.sleep(gap);
                continue;
            }

            if (this.destroyed) {
                break;
            }
            const entry = this.queue.shift();
            if (entry) {
                const ts = Date.now();
                this.timestamps10s.push(ts);
                this.timestamps7d.push(ts);
                this.lastRequestTime = ts;
                entry.resolve();
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
            queueLength: this.queue.length,
        };
    }
}
