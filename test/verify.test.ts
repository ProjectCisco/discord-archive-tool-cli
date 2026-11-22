import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ChannelType, MessageType } from 'discord-api-types/v10';
import { captureCategory } from '../src/capture.ts';
import { uploadToOneDrive } from '../src/destinations/onedrive.ts';
import { readState } from '../src/state.ts';
import { verifyArchive, type VerifyResult } from '../src/verify.ts';
import { CATEGORY, TEXT, channel, fake, message, server } from './fakes/discord.ts';
import { fakeDrive } from './fakes/drive.ts';

// Created in 2026, so Discord's thread message count applies to it.
const COUNTED_THREAD = '1440000000000000001';
const BASE = 'Team/Archives/Archive 2026';

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'verify-'));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

async function archived(messageCount = 1) {
  const world = server();
  const threads = world.archived[TEXT]?.public[0];
  assert.ok(threads);
  threads.push(channel(COUNTED_THREAD, ChannelType.PublicThread, 'counted', TEXT, { message_count: messageCount }));
  world.messages[COUNTED_THREAD] = [
    message('1440000000000000002', COUNTED_THREAD, { type: MessageType.ThreadStarterMessage, content: '' }),
    message('1440000000000000003', COUNTED_THREAD, { content: 'the one counted message' }),
  ];

  await captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
  const state = await readState(runDir);
  assert.ok(state);
  const drive = fakeDrive();
  drive.folder('Team/Archives');
  const treeDir = join(runDir, 'tree');
  await uploadToOneDrive({ graph: drive.graph, root: 'Team/Archives', treeDir, state, save: async () => {}, log: () => {} });
  const folderId = state.upload?.folderId;
  assert.ok(folderId);

  const verify = () =>
    verifyArchive({ discord: fake(world), graph: drive.graph, state, treeDir, folderId, log: () => {} });
  return { world, drive, treeDir, verify };
}

function failures(result: VerifyResult): Record<string, string[]> {
  assert.equal(result.passed, result.checks.every((check) => check.passed), 'passed only when every check passed');
  return Object.fromEntries(result.checks.filter((check) => !check.passed).map((check) => [check.name, check.problems]));
}

describe('verifyArchive', () => {
  test('passes all four checks on an untouched archive and records what OneDrive holds', async () => {
    const { verify } = await archived();
    const result = await verify();
    assert.deepEqual(failures(result), {});
    assert.equal(result.passed, true);
    assert.deepEqual(
      result.checks.map((check) => check.name),
      ['Complete capture', 'Files downloaded', 'Upload intact', 'Folders reachable'],
    );
    assert.deepEqual(result.remote['case-one/attachments/image.png'], { size: 8, quickXorHash: 'qx-8' });
  });

  test('fails when a message, thread or channel appears after capture', async () => {
    const { world, verify } = await archived();
    world.messages[TEXT]?.push(message('300000000000000999', TEXT, { content: 'late message' }));
    world.activeThreads.push(channel('100000000000000098', ChannelType.PublicThread, 'late thread', TEXT));
    world.channels.push(channel('100000000000000099', ChannelType.GuildText, 'late-channel', CATEGORY));
    assert.deepEqual(failures(await verify()), {
      'Complete capture': [
        '#late-channel was added to the category after capture',
        '#case-one has new messages since capture',
        '#case-one: thread "late thread" was created after capture',
      ],
    });
  });

  test('fails when Discord counts a different number of messages in a thread', async () => {
    const { verify } = await archived(2);
    assert.deepEqual(failures(await verify()), {
      'Complete capture': ['#case-one: thread "counted": Discord counts 2 messages, the archive has 1'],
    });
  });

  test('fails when a local file changed after capture', async () => {
    const { treeDir, verify } = await archived();
    await writeFile(join(treeDir, 'case-one', 'attachments', 'image.png'), 'tampered');
    const failed = failures(await verify());
    assert.deepEqual(failed['Files downloaded']?.slice(0, 1), ['case-one/attachments/image.png changed since the manifest was written']);
  });

  test('fails when a file in OneDrive differs, is missing, or was added', async () => {
    const { drive, verify } = await archived();
    // Same size, different bytes: only the checksum can catch this one.
    drive.tamper(`${BASE}/case-one/attachments/image.png`, 'XXXXXXXX');
    drive.tamper(`${BASE}/case-one/case-one.json`, '{}');
    drive.remove(`${BASE}/_index.html`);
    drive.add(drive.folder(`${BASE}/case-one`).id, 'notes.txt', false, new TextEncoder().encode('stray'));

    const problems = failures(await verify())['Upload intact'] ?? [];
    assert.equal(problems.length, 4, problems.join('\n'));
    assert.ok(problems.includes("case-one/attachments/image.png in OneDrive doesn't match the local copy"));
    assert.ok(problems.some((line) => /^case-one\/case-one\.json is 2 bytes in OneDrive, \d+ locally$/.test(line)));
    assert.ok(problems.includes('_index.html is missing from OneDrive'));
    assert.ok(problems.includes('case-one/notes.txt is in OneDrive but not in the archive'));
  });

  test('fails when a channel folder is gone from OneDrive', async () => {
    const { drive, verify } = await archived();
    drive.remove(`${BASE}/hearing`);
    const failed = failures(await verify());
    assert.deepEqual(failed['Folders reachable'], ['Folder hearing has no address in OneDrive']);
    assert.ok(failed['Upload intact']?.includes('hearing/hearing.html is missing from OneDrive'));
  });
});
