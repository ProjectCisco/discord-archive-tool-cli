import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { explain } from '../src/errors.ts';

describe('explain', () => {
  test('brings the real network reason forward from fetch', () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND graph.microsoft.com'), { code: 'ENOTFOUND' }) });
    assert.equal(explain(error), 'fetch failed (ENOTFOUND)');
    assert.equal(explain(new Error('plain')), 'plain');
    assert.equal(explain('a string'), 'a string');
  });
});
