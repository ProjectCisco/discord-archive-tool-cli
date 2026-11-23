import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mapParallel } from '../src/parallel.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapParallel', () => {
  test('returns the results in the order of the items, whichever finishes first', async () => {
    const delays = [30, 1, 20, 1, 10];
    const results = await mapParallel(delays, async (delay) => {
      await pause(delay);
      return delay * 2;
    });
    assert.deepEqual(results, [60, 2, 40, 2, 20]);
    assert.deepEqual(await mapParallel([], async () => 1), []);
  });

  test('never runs more than the limit at once, and uses all of it', async () => {
    let running = 0;
    let most = 0;
    await mapParallel(
      Array.from({ length: 20 }, (_, index) => index),
      async () => {
        most = Math.max(most, ++running);
        await pause(2);
        running--;
      },
      3,
    );
    assert.equal(most, 3);
  });

  test('after a failure starts nothing new, and lets running work finish before it throws', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const run = mapParallel(
      [0, 1, 2, 3, 4, 5, 6, 7],
      async (item) => {
        started.push(item);
        await pause(item === 1 ? 1 : 15);
        if (item === 1) throw new Error('item 1 failed');
        finished.push(item);
      },
      2,
    );
    await assert.rejects(run, /item 1 failed/);
    // Item 0 was running when item 1 failed: it finished, and nothing after it began.
    assert.deepEqual(started, [0, 1]);
    assert.deepEqual(finished, [0]);
  });
});
