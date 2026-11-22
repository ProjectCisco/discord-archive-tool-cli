import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { acquireLock, readState, writeFileAtomic, writeState, type RunState } from '../src/state.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const state: RunState = {
  schema: 2,
  guildId: '100000000000000001',
  categoryId: '100000000000000002',
  categoryName: 'Archive 2026',
  startedAt: '2026-11-22T10:00:00.000Z',
  channels: {},
};

describe('writeFileAtomic', () => {
  test('replaces the file and leaves no temporary file', async () => {
    const path = join(dir, 'a.txt');
    await writeFileAtomic(path, 'first');
    await writeFileAtomic(path, 'second');
    assert.equal(await readFile(path, 'utf8'), 'second');
    assert.deepEqual(await readdir(dir), ['a.txt']);
  });
});

describe('run state', () => {
  test('reads back what was written', async () => {
    await writeState(dir, state);
    assert.deepEqual(await readState(dir), state);
  });

  test('keeps the last complete state when a crash leaves a half-written temporary file', async () => {
    await writeState(dir, state);
    await writeFile(join(dir, 'state.json.tmp'), '{"schema": 2, "guil');
    assert.deepEqual(await readState(dir), state);
  });

  test('refuses to resume a run made by a different version', async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, schema: 1 }));
    await assert.rejects(readState(dir), /different version of this tool\. Delete that folder and run again/);
  });
});

describe('acquireLock', () => {
  test('stops a second run and allows one after release', async () => {
    const release = await acquireLock(dir);
    await assert.rejects(acquireLock(dir), /Another run is using/);
    await release();
    const again = await acquireLock(dir);
    await again();
  });
});
