import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { MessageReferenceType, MessageType } from 'discord-api-types/v10';
import type { APIAttachment } from 'discord-api-types/v10';
import { captureCategory } from '../src/capture.ts';
import { parseManifest } from '../src/manifest.ts';
import type { Transcript } from '../src/transcript.ts';
import {
  ALICE,
  CATEGORY,
  IMAGE,
  MESSAGE_THREAD,
  POST_ACTIVE,
  POST_ARCHIVED,
  POST_ARCHIVED_OLDER,
  PRIVATE_THREAD,
  TEXT,
  channel,
  fake,
  server,
  type FakeServer,
} from './fakes/discord.ts';

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'capture-'));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

async function readTranscript(folder: string): Promise<Transcript> {
  return JSON.parse(await readFile(join(runDir, 'tree', '_data', `${folder}.json`), 'utf8')) as Transcript;
}

async function readPage(folder: string): Promise<string> {
  return readFile(join(runDir, 'tree', folder, `${folder}.html`), 'utf8');
}

function thread(transcript: Transcript, id: string) {
  const found = transcript.threads.find((item) => item.channel.id === id);
  assert.ok(found, `thread ${id} captured`);
  return found;
}

describe('captureCategory', () => {
  test('captures every message in order across pages', async () => {
    const world = server();
    const result = await captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const transcript = await readTranscript('case-one');
    assert.equal(transcript.messages.length, 150);
    const ids = transcript.messages.map((item) => BigInt(item.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : 1)));
    assert.ok(world.calls.includes(`messages ${TEXT} after 300000000000000149`), 'asked for more after the last page');
    assert.equal(result.channels, 3);
  });

  test('archives text chat in voice channels', async () => {
    await captureCategory({ discord: fake(server()), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const transcript = await readTranscript('hearing');
    assert.equal(transcript.messages[0]?.content, 'voice chat text');
  });

  test('downloads attachments at the stated size and refreshes an expired link once', async () => {
    const world = server();
    await captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const transcript = await readTranscript('case-one');
    const first = transcript.files['400000000000000001'];
    const second = transcript.files['400000000000000002'];
    assert.equal(first?.path, 'attachments/image.png');
    assert.equal(second?.path, 'attachments/image (2).png');
    assert.equal(second?.sha256, createHash('sha256').update(IMAGE).digest('hex'));
    assert.equal((await stat(join(runDir, 'tree', 'case-one', 'attachments', 'image (2).png'))).size, IMAGE.byteLength);
    assert.ok(world.calls.includes(`message ${TEXT}/300000000000000000`), 'refetched the message for a fresh URL');
  });

  function withFirstAttachment(world: FakeServer, change: Partial<APIAttachment>): void {
    const first = world.messages[TEXT]?.[0];
    const attachment = first?.attachments[0];
    assert.ok(first && attachment);
    first.attachments = [{ ...attachment, ...change }];
  }

  async function assertStops(world: FakeServer, pattern: RegExp): Promise<void> {
    await assert.rejects(
      captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} }),
      pattern,
    );
    assert.deepEqual(await readdir(join(runDir, 'tree', 'case-one', 'attachments')), [], 'no partial file left');
  }

  test('saves the original upload when Discord records a converted copy, and says so', async () => {
    const world = server();
    withFirstAttachment(world, { size: 5, content_type: 'image/webp' });
    const result = await captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const saved = (await readTranscript('case-one')).files['400000000000000001'];
    assert.equal(saved?.size, IMAGE.byteLength);
    assert.equal(saved?.declaredSize, 5);
    assert.equal(result.converted, 1);
    assert.match(await readFile(join(runDir, 'tree', '_index.html'), 'utf8'), /1 file was saved as the original upload/);
  });

  test('stops when the size differs and the server gave no length to check against', async () => {
    const world = server();
    withFirstAttachment(world, { size: 999 });
    world.headers['https://cdn.test/a'] = { contentLength: null };
    await assertStops(world, /Couldn't download "image.png".*got 8 bytes \(image\/png\), Discord says 999 \(image\/png\)/);
  });

  test('stops when fewer bytes arrive than the server said it would send', async () => {
    const world = server();
    withFirstAttachment(world, { size: 999 });
    world.headers['https://cdn.test/a'] = { contentLength: 999 };
    await assertStops(world, /got 8 bytes/);
  });

  test('stops when the server sends a different kind of content, such as an error page', async () => {
    const world = server();
    withFirstAttachment(world, { size: 999 });
    world.headers['https://cdn.test/a'] = { contentType: 'text/html' };
    await assertStops(world, /got 8 bytes \(text\/html\), Discord says 999 \(image\/png\)/);
  });

  test('stops when the body was compressed, so the stated length cannot be trusted', async () => {
    const world = server();
    withFirstAttachment(world, { size: 999 });
    world.headers['https://cdn.test/a'] = { encoded: true };
    await assertStops(world, /got 8 bytes/);
  });

  test('gives staff one folder per channel with just the chat page and its files, and keeps the rest in _data', async () => {
    await captureCategory({ discord: fake(server()), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const tree = join(runDir, 'tree');
    assert.deepEqual((await readdir(tree)).sort(), ['_data', '_index.html', 'appeals', 'case-one', 'hearing']);
    assert.deepEqual((await readdir(join(tree, 'case-one'))).sort(), ['attachments', 'case-one.html']);
    assert.deepEqual((await readdir(join(tree, 'appeals'))).sort(), ['appeals.html']);
    assert.deepEqual((await readdir(join(tree, '_data'))).sort(), ['_manifest-sha256.txt', 'appeals.json', 'case-one.json', 'hearing.json']);
    // The thread's file lands beside the channel's own, numbered so nothing is overwritten.
    const transcript = await readTranscript('case-one');
    assert.equal(transcript.files['400000000000000003']?.path, 'attachments/image (3).png');
  });

  test('captures public and private threads and places each under the message that started it', async () => {
    await captureCategory({ discord: fake(server()), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const transcript = await readTranscript('case-one');
    assert.equal(transcript.kind, 'channel');
    assert.deepEqual(
      transcript.threads.map((item) => item.channel.name),
      ['staff notes', 'evidence'],
    );
    assert.equal(thread(transcript, MESSAGE_THREAD).startMessageId, MESSAGE_THREAD);
    assert.equal(thread(transcript, PRIVATE_THREAD).startMessageId, null);
    assert.equal(thread(transcript, PRIVATE_THREAD).messages[0]?.content, 'private follow-up');

    const page = await readPage('case-one');
    const start = page.indexOf(`id="msg-${MESSAGE_THREAD}"`);
    const section = page.indexOf(`id="thread-${MESSAGE_THREAD}"`);
    assert.ok(start !== -1 && section > start, 'thread follows its start message');
    assert.ok(section < page.indexOf('id="msg-300000000000000011"'), 'and comes before the next message');
    assert.ok(page.indexOf('Other threads') < page.indexOf(`id="thread-${PRIVATE_THREAD}"`), 'unplaced thread at the end');
  });

  test('places a thread started on its own under its "started a thread" notice', async () => {
    const world = server();
    const notice = world.messages[TEXT]?.[20];
    assert.ok(notice);
    notice.type = MessageType.ThreadCreated;
    notice.message_reference = { type: MessageReferenceType.Default, channel_id: PRIVATE_THREAD };
    await captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    assert.equal(thread(await readTranscript('case-one'), PRIVATE_THREAD).startMessageId, notice.id);
  });

  test('captures active and archived forum posts onto one page with a list at the top', async () => {
    await captureCategory({ discord: fake(server()), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const forum = await readTranscript('appeals');
    assert.equal(forum.kind, 'forum');
    assert.deepEqual(forum.messages, []);
    assert.deepEqual(
      forum.threads.map((post) => [post.channel.name, post.startMessageId]),
      [['first appeal', null], ['old appeal', null], ['oldest appeal', null]],
    );
    assert.equal(thread(forum, POST_ACTIVE).messages[0]?.content, 'appeal opened');
    assert.equal(thread(forum, POST_ARCHIVED).messages[0]?.message_snapshots?.[0]?.message.content, 'forwarded evidence');

    const page = await readPage('appeals');
    for (const id of [POST_ACTIVE, POST_ARCHIVED, POST_ARCHIVED_OLDER]) {
      assert.ok(page.indexOf(`href="#post-${id}"`) < page.indexOf(`id="post-${id}"`), `post ${id} listed, then shown`);
    }
  });

  test('stops rather than skip threads when Discord gives no point to page from', async () => {
    const discord = fake(server());
    discord.archivedThreads = async () => ({ threads: [], has_more: true });
    await assert.rejects(
      captureCategory({ discord, categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} }),
      /more archived threads .* no point to continue from/,
    );
  });

  test('uses server nicknames and records the forwarded message author', async () => {
    await captureCategory({ discord: fake(server()), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const transcript = await readTranscript('appeals');
    assert.equal(transcript.resolved.users[ALICE.id]?.displayName, 'Alice (Mod)');
    assert.equal(transcript.resolved.forwardAuthors[POST_ARCHIVED]?.username, 'alice');
  });

  test('writes an index and a manifest that covers every file', async () => {
    await captureCategory({ discord: fake(server()), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const tree = join(runDir, 'tree');
    const manifest = parseManifest(await readFile(join(tree, '_data', '_manifest-sha256.txt'), 'utf8'));
    const files = (await readdir(tree, { recursive: true, withFileTypes: true }))
      .filter((item) => item.isFile() && item.name !== '_manifest-sha256.txt')
      .map((item) => join(item.parentPath, item.name).slice(tree.length + 1).split('\\').join('/'));
    assert.deepEqual([...manifest.keys()].sort(), files.sort());
    assert.ok(manifest.has('_index.html'));
    assert.ok(manifest.has('case-one/case-one.html'));
    assert.ok(manifest.has('_data/case-one.json'));
    assert.ok(manifest.has('case-one/attachments/image (3).png'));
    // The same check anyone can run by hand, from the archive folder.
    if (spawnSync('sha256sum', ['--version']).error === undefined) {
      execFileSync('sha256sum', ['-c', '--quiet', '_data/_manifest-sha256.txt'], { cwd: tree });
    }
  });

  test('never lets a channel called _data take the tool’s own folder', async () => {
    const world = server();
    const text = world.channels.find((channel) => channel.id === TEXT);
    assert.ok(text);
    text.name = '_data';
    await captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const folders = await readdir(join(runDir, 'tree'));
    assert.ok(folders.includes('_data (000003)'), folders.join(', '));
    assert.deepEqual((await readdir(join(runDir, 'tree', '_data (000003)'))).sort(), ['_data (000003).html', 'attachments']);
  });

  test('refuses a category holding a channel type it cannot archive, before writing anything', async () => {
    const world = server();
    world.channels.push(channel('100000000000000010', 99, 'mystery', CATEGORY));
    await assert.rejects(
      captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} }),
      /Can't archive these channels: #mystery \(type 99\)/,
    );
    await assert.rejects(stat(join(runDir, 'tree')), { code: 'ENOENT' });
  });

  test('refuses an ID that is not a category', async () => {
    await assert.rejects(
      captureCategory({ discord: fake(server()), categoryId: TEXT, runDir, operator: 'tester', log: () => {} }),
      /is not a server category/,
    );
  });

  test('resumes without capturing finished channels again', async () => {
    const world = server();
    await captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    world.calls.length = 0;
    const lines: string[] = [];
    await captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log: (line) => lines.push(line) });
    assert.ok(!world.calls.some((call) => call.startsWith('messages')), 'no messages fetched again');
    assert.equal(lines.filter((line) => line.endsWith('already captured')).length, 3);
  });

  test('links every channel from the index to its chat page', async () => {
    await captureCategory({ discord: fake(server()), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    const index = await readFile(join(runDir, 'tree', '_index.html'), 'utf8');
    for (const folder of ['case-one', 'appeals', 'hearing']) assert.match(index, new RegExp(`href="${folder}/${folder}.html"`));
  });
});
