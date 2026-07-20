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
  pendingQueue = [];
  processing = false;
  lastRequestTime = 0;
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
  async acquire(key) {
    const now = Date.now();
    this.prune(now);
    if (this.timestamps7d.length >= LIMIT_7D) {
      throw new Error(
        `Smartgarden rate limit exhausted: ${this.timestamps7d.length}/${LIMIT_7D} requests in the last 7 days`
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
   * Waits until at least MIN_INTERVAL_MS has passed since the last
   * recorded request.
   */
  async waitForMinInterval() {
    const gap = this.lastRequestTime + MIN_INTERVAL_MS - Date.now();
    if (gap > 0) {
      await new Promise((r) => setTimeout(r, gap));
    }
  }
  /**
   * Removes any queued entry with the given key, rejecting it with
   * CancelledError so the caller can abort cleanly.
   *
   * @param key
   */
  cancelKey(key) {
    const idx = this.pendingQueue.findIndex((e) => e.key === key);
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
  enqueue(key) {
    return new Promise((resolve, reject) => {
      this.pendingQueue.push({ key, resolve, reject });
      if (!this.processing) {
        this.processing = true;
        void this.drain();
      }
    });
  }
  async drain() {
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
        await new Promise((r) => setTimeout(r, delay));
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
      queueLength: this.pendingQueue.length
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CancelledError,
  RateLimiter
});
//# sourceMappingURL=rate-limiter.js.map
