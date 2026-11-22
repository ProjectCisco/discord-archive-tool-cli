import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ChannelType } from 'discord-api-types/v10';
import { captureCategory } from '../src/capture.ts';
import { uploadArchive, writeRunRecord } from '../src/archive-folder.ts';
import { RUN_RECORD_PATH } from '../src/layout.ts';
import { deleteChannels, plan, recheck, refusal } from '../src/remove.ts';
import { readState, type RunState } from '../src/state.ts';
import { verifyArchive } from '../src/verify.ts';
import { CATEGORY, FORUM, TEXT, VOICE, channel, fake, message, server } from './fakes/discord.ts';
import { fakeStore } from './fakes/store.ts';

const BASE = 'Team/Archives/Archive 2026';

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'remove-'));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

// A category captured, uploaded and verified, exactly as archive leaves it.
async function verified() {
  const world = server();
  await captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
  const state = await readState(runDir);
  assert.ok(state);
  const drive = fakeStore();
  drive.folder('Team/Archives');
  const treeDir = join(runDir, 'tree');
  const store = drive.store;
  await uploadArchive({ store, destination: 'onedrive', treeDir, state, save: async () => {}, log: () => {} });
  const folderId = state.upload?.folderId;
  assert.ok(folderId);
  const result = await verifyArchive({ discord: fake(world), store, state, treeDir, folderId, log: () => {} });
  assert.ok(result.passed);
  await writeRunRecord(store, folderId, state, 'verified');
  state.verification = { status: 'verified', at: '2026-11-22T10:00:00.000Z', checks: result.checks, remote: result.remote };

  const check = () => recheck({ discord: fake(world), store, state, treeDir });
  const remove = (saves: string[] = [], audits: string[] = []) =>
    deleteChannels({
      discord: fake(world),
      state,
      reason: 'Archived and verified: https://onedrive.test/archive',
      save: async () => {
        saves.push(JSON.stringify(state.deletion));
      },
      onDeleted: async (deleted, outcome) => {
        audits.push(`${deleted.name}: ${outcome}`);
      },
      log: () => {},
    });
  return { world, drive, state, folderId, check, remove };
}

describe('refusal', () => {
  const base: RunState = {
    schema: 3,
    guildId: '1',
    categoryId: '2',
    categoryName: 'x',
    startedAt: '2026-11-22T10:00:00.000Z',
    channels: {},
  };

  test('refuses without an archive, without a verified one, and after a finished delete', () => {
    assert.match(refusal(null) ?? '', /No archive of this category/);
    assert.match(refusal(base) ?? '', /no verified archive/);
    const failed = { ...base, verification: { status: 'failed' as const, at: '', checks: [], remote: {} } };
    assert.match(refusal({ ...failed, upload: { destination: 'onedrive', folderId: 'f', webUrl: '', files: {} } }) ?? '', /no verified archive/);
    const ready: RunState = {
      ...base,
      upload: { destination: 'onedrive', folderId: 'f', webUrl: '', files: {} },
      verification: { status: 'verified', at: '', checks: [], remote: {} },
    };
    assert.equal(refusal(ready), null);
    assert.match(refusal({ ...ready, deletion: { startedAt: '', deleted: {}, finishedAt: 'x' } }) ?? '', /already deleted/);
  });
});

describe('recheck', () => {
  test('passes when nothing changed in Discord or OneDrive', async () => {
    const { check } = await verified();
    assert.deepEqual((await check()), []);
  });

  test('refuses after a late message, thread or channel', async () => {
    const { world, check } = await verified();
    world.messages[TEXT]?.push(message('300000000000000999', TEXT, { content: 'late message' }));
    world.activeThreads.push(channel('100000000000000098', ChannelType.PublicThread, 'late thread', TEXT));
    world.channels.push(channel('100000000000000099', ChannelType.GuildText, 'late-channel', CATEGORY));
    assert.deepEqual((await check()), [
      '#late-channel was added to the category after capture',
      '#case-one has new messages since capture',
      '#case-one: thread "late thread" was created after capture',
    ]);
  });

  test('refuses when OneDrive changed: an edit of the same size, a removal, or an addition', async () => {
    const { drive, check } = await verified();
    drive.tamper(`${BASE}/case-one/attachments/image.png`, 'XXXXXXXX');
    drive.remove(`${BASE}/_index.html`);
    drive.add(drive.folder(`${BASE}/hearing`).id, 'notes.txt', false, new TextEncoder().encode('stray'));
    assert.deepEqual((await check()).sort(), [
      '_index.html is no longer in Test Drive',
      'case-one/attachments/image.png changed in Test Drive since it was verified',
      'hearing/notes.txt was added to Test Drive after verification',
    ]);
  });

  test('refuses when the run record no longer says verified', async () => {
    const { drive, state, folderId, check } = await verified();
    await writeRunRecord(drive.store, folderId, state, 'uploaded');
    assert.deepEqual((await check()), [`${RUN_RECORD_PATH} in Test Drive no longer says verified`]);
  });
});

describe('deleteChannels', () => {
  test('deletes every captured channel one at a time, saving before and after each, and keeps the category', async () => {
    const { world, state, remove } = await verified();
    const saves: string[] = [];
    const audits: string[] = [];
    const result = await remove(saves, audits);

    assert.deepEqual(result.deleted.map((item) => item.name), ['case-one', 'appeals', 'hearing']);
    assert.deepEqual(audits, ['case-one: deleted', 'appeals: deleted', 'hearing: deleted']);
    assert.deepEqual(
      world.calls.filter((call) => call.startsWith('delete')),
      [TEXT, FORUM, VOICE].map((id) => `delete ${id}: Archived and verified: https://onedrive.test/archive`),
    );
    assert.ok(world.channels.some((item) => item.id === CATEGORY), 'category kept');
    assert.equal(JSON.parse(saves[0] ?? '{}').inProgress, TEXT, 'state names the channel before it is deleted');
    assert.ok(state.deletion?.finishedAt);
    assert.deepEqual(plan(state), []);
  });

  test('keeps a channel moved out of the category since the archive', async () => {
    const { world, state, remove } = await verified();
    const moved = world.channels.find((item) => item.id === VOICE);
    assert.ok(moved);
    moved.parent_id = null;
    const result = await remove();
    assert.deepEqual(result.skipped.map((item) => item.channel.name), ['hearing']);
    assert.ok(world.channels.some((item) => item.id === VOICE), 'moved channel still exists');
    assert.deepEqual(state.deletion?.kept, { [VOICE]: 'moved out of the category' });
  });

  test('counts a channel someone already deleted as gone, without calling delete', async () => {
    const { world, remove } = await verified();
    world.channels = world.channels.filter((item) => item.id !== FORUM);
    const audits: string[] = [];
    await remove([], audits);
    assert.ok(audits.includes('appeals: gone'));
    assert.ok(!world.calls.includes(`delete ${FORUM}: Archived and verified: https://onedrive.test/archive`));
  });

  test('stops at the first refused delete and carries on from there next time', async () => {
    const { world, state, remove } = await verified();
    world.protected = [FORUM];
    await assert.rejects(remove(), /Missing Permissions/);
    assert.deepEqual(Object.keys(state.deletion?.deleted ?? {}), [TEXT]);
    assert.equal(state.deletion?.inProgress, FORUM, 'state shows which channel was interrupted');
    assert.equal(state.deletion?.finishedAt, undefined);

    world.protected = [];
    world.calls.length = 0;
    const result = await remove();
    assert.deepEqual(result.deleted.map((item) => item.name), ['appeals', 'hearing']);
    assert.ok(!world.calls.some((call) => call.startsWith(`delete ${TEXT}`)), 'did not touch the finished channel again');
  });
});
