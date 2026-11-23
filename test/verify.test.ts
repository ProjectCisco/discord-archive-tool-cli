import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ChannelType, MessageType } from 'discord-api-types/v10';
import { captureCategory } from '../src/capture.ts';
import { uploadArchive } from '../src/archive-folder.ts';
import { readState } from '../src/state.ts';
import { verifyArchive, type VerifyResult } from '../src/verify.ts';
import { CATEGORY, IMAGE, TEXT, channel, fake, message, server } from './fakes/discord.ts';
import { fakeStore } from './fakes/store.ts';

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
  const drive = fakeStore();
  drive.folder('Team/Archives');
  const treeDir = join(runDir, 'tree');
  await uploadArchive({ store: drive.store, destination: 'onedrive', treeDir, state, save: async () => {}, log: () => {} });
  const folderId = state.upload?.folderId;
  assert.ok(folderId);

  const verify = () =>
    verifyArchive({ discord: fake(world), store: drive.store, state, treeDir, folderId, log: () => {} });
  return { world, drive, treeDir, state, folderId, verify };
}

function failures(result: VerifyResult): Record<string, string[]> {
  assert.equal(result.passed, result.checks.every((check) => check.passed), 'passed only when every check passed');
  return Object.fromEntries(result.checks.filter((check) => !check.passed).map((check) => [check.name, check.problems]));
}

describe('verifyArchive', () => {
  test('passes all four checks on an untouched archive and records what the destination holds', async () => {
    const { drive, verify } = await archived();
    const result = await verify();
    assert.deepEqual(failures(result), {});
    assert.equal(result.passed, true);
    assert.deepEqual(
      result.checks.map((check) => check.name),
      ['Complete capture', 'Files downloaded', 'Upload intact', 'Folders reachable'],
    );
    assert.deepEqual(result.remote['case-one/attachments/image.png'], { size: 8, checksum: drive.checksum(IMAGE) });
  });

  test('looks at Discord and reads files back several at a time, with the same result', async () => {
    const { world, drive, treeDir, state, folderId, verify } = await archived();
    // Long enough that four at once are sure to overlap, whatever else the machine is doing.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
    const busy = { lookups: 0, mostLookups: 0, downloads: 0, mostDownloads: 0 };
    const discord = fake(world);
    const { messagesAfter } = discord;
    discord.messagesAfter = async (...args) => {
      busy.mostLookups = Math.max(busy.mostLookups, ++busy.lookups);
      await pause();
      busy.lookups--;
      return messagesAfter(...args);
    };
    const { download } = drive.store;
    drive.store.download = async (id) => {
      busy.mostDownloads = Math.max(busy.mostDownloads, ++busy.downloads);
      await pause();
      busy.downloads--;
      return download(id);
    };

    const slow = await verifyArchive({ discord, store: drive.store, state, treeDir, folderId, log: () => {} });
    assert.equal(busy.mostLookups, 4);
    assert.equal(busy.mostDownloads, 4);
    drive.store.download = download;
    assert.deepEqual(slow, await verify());
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

  test('fails when Discord counts more messages in a thread than the archive has', async () => {
    const { verify } = await archived(2);
    assert.deepEqual(failures(await verify()), {
      'Complete capture': ['#case-one: thread "counted": Discord counts 2 messages, the archive has only 1'],
    });
  });

  test('passes when Discord counts fewer messages in a thread than the archive has', async () => {
    // Seen on real threads: Discord's count ran 1 to 3 under the messages it returned.
    const { verify } = await archived(0);
    assert.deepEqual(failures(await verify()), {});
  });

  test('fails when a message is saved twice', async () => {
    const { treeDir, verify } = await archived();
    const file = join(treeDir, '_data', 'case-one.json');
    const transcript = JSON.parse(await readFile(file, 'utf8')) as { messages: unknown[] };
    transcript.messages.push(transcript.messages[0]);
    await writeFile(file, JSON.stringify(transcript));
    assert.deepEqual(failures(await verify())['Complete capture'], ['#case-one has a message saved twice']);
  });

  test('fails when a local file changed after capture', async () => {
    const { treeDir, verify } = await archived();
    await writeFile(join(treeDir, 'case-one', 'attachments', 'image.png'), 'tampered');
    const failed = failures(await verify());
    assert.deepEqual(failed['Files downloaded']?.slice(0, 1), ['case-one/attachments/image.png changed since the manifest was written']);
  });

  test('fails when a file in Test Drive differs, is missing, or was added', async () => {
    const { drive, verify } = await archived();
    // Same size, different bytes: only the checksum can catch this one.
    drive.tamper(`${BASE}/case-one/attachments/image.png`, 'XXXXXXXX');
    drive.tamper(`${BASE}/_data/case-one.json`, '{}');
    drive.remove(`${BASE}/_index.html`);
    drive.add(drive.folder(`${BASE}/case-one`).id, 'notes.txt', false, new TextEncoder().encode('stray'));

    const problems = failures(await verify())['Upload intact'] ?? [];
    assert.equal(problems.length, 4, problems.join('\n'));
    assert.ok(problems.includes("case-one/attachments/image.png in Test Drive doesn't match the local copy"));
    assert.ok(problems.some((line) => /^_data\/case-one\.json is 2 bytes in Test Drive, \d+ locally$/.test(line)));
    assert.ok(problems.includes('_index.html is missing from Test Drive'));
    assert.ok(problems.includes('case-one/notes.txt is in Test Drive but not in the archive'));
  });

  test('reads a file back again when the download fails part-way, and stops if it keeps failing', async () => {
    const { drive, verify } = await archived();
    const { download } = drive.store;
    let drops = 2;
    drive.store.download = async (id) => {
      if (drops-- > 0) throw new Error('connection reset');
      return download(id);
    };
    assert.deepEqual(failures(await verify()), {});

    drive.store.download = async () => {
      throw new Error('connection reset');
    };
    await assert.rejects(verify(), /connection reset/);
  });

  test('fails when a channel folder is gone from Test Drive', async () => {
    const { drive, verify } = await archived();
    drive.remove(`${BASE}/hearing`);
    const failed = failures(await verify());
    assert.deepEqual(failed['Folders reachable'], ['Folder hearing has no address in Test Drive']);
    assert.ok(failed['Upload intact']?.includes('hearing/hearing.html is missing from Test Drive'));
  });
});
