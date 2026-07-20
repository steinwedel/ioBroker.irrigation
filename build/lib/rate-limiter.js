"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var rate_limiter_exports = {};
__export(rate_limiter_exports, {
  CancelledError: () => CancelledError,
  RateLimiter: () => RateLimiter
});
module.exports = __toCommonJS(rate_limiter_exports);
const LIMIT_10S = 9;
const WINDOW_10S_MS = 1e4;
const LIMIT_7D = 699;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1e3;
const MIN_INTERVAL_MS = 1e3;
class CancelledError extends Error {
  constructor() {
    super("Rate-limited request cancelled (superseded by newer command)");
    this.name = "CancelledError";
  }
}
class RateLimiter {
  timestamps10s = [];
  timestamps7d = [];
  /**
   * Every acquire() call is appended here and only ever granted a slot by
   * the single drain() loop below, one at a time - this is what makes
   * acquire() safe to call concurrently from multiple valves.
   */
  queue = [];
  processing = false;
  lastRequestTime = 0;
  destroyed = false;
  /** Maps each in-flight sleep() timer to its resolve callback, so destroy() can settle it. */
  activeTimers = /* @__PURE__ */ new Map();
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
  destroy() {
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
  sleep(ms) {
    return new Promise((resolve) => {
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
  acquire(key) {
    if (this.destroyed) {
      return Promise.reject(new CancelledError());
    }
    this.cancelKey(key);
    return new Promise((resolve, reject) => {
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
  prune(now) {
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
  cancelKey(key) {
    const idx = this.queue.findIndex((e) => e.key === key);
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
  async drain() {
    while (this.queue.length > 0 && !this.destroyed) {
      const now = Date.now();
      this.prune(now);
      if (this.timestamps7d.length >= LIMIT_7D) {
        const entry2 = this.queue.shift();
        entry2 == null ? void 0 : entry2.reject(
          new Error(
            `Smartgarden rate limit exhausted: ${this.timestamps7d.length}/${LIMIT_7D} requests in the last 7 days`
          )
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
  getState() {
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
      queueLength: this.queue.length
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CancelledError,
  RateLimiter
});
//# sourceMappingURL=rate-limiter.js.map
