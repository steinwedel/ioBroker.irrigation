/**
 * Unit tests for RateLimiter, focusing on the concurrency guarantee that
 * caused a real Husqvarna/Gardena API rate-limit violation: acquire() calls
 * triggered by independent valve event handlers can happen concurrently, and
 * must never be granted a slot within MIN_INTERVAL_MS of each other even
 * when several calls race in before any of them has recorded a timestamp.
 */

import { expect } from 'chai';
import { CancelledError, RateLimiter } from './rate-limiter';

const MIN_INTERVAL_MS = 1_000;

describe('RateLimiter concurrency', () => {
    it('serializes concurrent acquire() calls so none are granted within MIN_INTERVAL_MS of each other', async function () {
        this.timeout(8_000);
        const limiter = new RateLimiter();

        // Fire several acquire() calls "at the same time" (no await between
        // them), simulating multiple valves whose start()/stop() are
        // triggered by independent onOwnStateChange events landing in the
        // same event-loop tick. Before the fix, these could all observe an
        // empty window and the same stale lastRequestTime, and all resolve
        // together instead of being spaced out.
        const callCount = 4;
        const timestamps: number[] = [];
        await Promise.all(
            Array.from({ length: callCount }, (_, i) =>
                limiter.acquire(`valve-${i}`).then(() => {
                    timestamps.push(Date.now());
                }),
            ),
        );

        expect(timestamps).to.have.lengthOf(callCount);
        timestamps.sort((a, b) => a - b);
        for (let i = 1; i < timestamps.length; i++) {
            const gap = timestamps[i] - timestamps[i - 1];
            expect(gap).to.be.at.least(
                MIN_INTERVAL_MS - 25,
                `acquire() calls ${i - 1} and ${i} were granted only ${gap}ms apart, ` +
                    `violating the ${MIN_INTERVAL_MS}ms minimum interval`,
            );
        }

        limiter.destroy();
    });

    it('cancels a superseded queued entry for the same key instead of granting it a slot', async function () {
        this.timeout(15_000);
        const limiter = new RateLimiter();

        // Saturate the 10s window so the next acquire() for "valve-0" has to queue.
        for (let i = 0; i < 9; i++) {
            await limiter.acquire(`filler-${i}`);
        }

        const firstCall = limiter.acquire('valve-0');
        // A second call for the same key while the first is still queued
        // must cancel the first one (e.g. a start() immediately superseded
        // by a stop()).
        const secondCall = limiter.acquire('valve-0');

        let firstCallRejectedWithCancelledError = false;
        try {
            await firstCall;
        } catch (error) {
            firstCallRejectedWithCancelledError = error instanceof CancelledError;
        }

        expect(firstCallRejectedWithCancelledError).to.equal(true);
        await secondCall; // must still resolve normally
        limiter.destroy();
    });

    it('destroy() rejects everything still queued instead of hanging forever', async function () {
        this.timeout(15_000);
        const limiter = new RateLimiter();

        for (let i = 0; i < 9; i++) {
            await limiter.acquire(`filler-${i}`);
        }
        const queuedCall = limiter.acquire('valve-queued');

        limiter.destroy();

        let rejectedWithCancelledError = false;
        try {
            await queuedCall;
        } catch (error) {
            rejectedWithCancelledError = error instanceof CancelledError;
        }
        expect(rejectedWithCancelledError).to.equal(true);
    });
});
