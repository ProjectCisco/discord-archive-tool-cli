import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { countdown } from '../src/countdown.ts';

describe('countdown', () => {
  test('counts down and lets the delete go ahead', async () => {
    const written: string[] = [];
    assert.equal(await countdown(3, (text) => written.push(text), 1), true);
    assert.equal(written.join(''), 'Deleting in 3s. Press Ctrl+C to stop. 2 1 \n');
    assert.equal(process.listenerCount('SIGINT'), 0, 'no Ctrl+C handler left behind');
  });

  test('stops on Ctrl+C, so nothing is deleted', async () => {
    const running = countdown(10, () => {}, 50);
    process.emit('SIGINT');
    assert.equal(await running, false);
    assert.equal(process.listenerCount('SIGINT'), 0);
  });
});
