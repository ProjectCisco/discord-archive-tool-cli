import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ChannelType, MessageReferenceType, MessageType } from 'discord-api-types/v10';
import type { APIAttachment } from 'discord-api-types/v10';
import { captureCategory } from '../src/capture.ts';
import { parseManifest } from '../src/manifest.ts';
import { readState, writeState } from '../src/state.ts';
import type { Transcript } from '../src/transcript.ts';
import {
  ALICE,
  CATEGORY,
  FORUM,
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

function run(world: FakeServer, log: (line: string) => void = () => {}) {
  return captureCategory({ discord: fake(world), categoryId: CATEGORY, runDir, operator: 'tester', log });
}

// Archived forum posts with set archive times, newest first.
function archivedPosts(world: FakeServer, times: string[]): string[] {
  const ids = times.map((_, index) => String(110000000000000000n + BigInt(index)));
  const posts = times.map((time, index) =>
    channel(ids[index] ?? '', ChannelType.PublicThread, `post ${index + 1}`, FORUM, { thread_metadata: { archive_timestamp: time } }),
  );
  world.archived[FORUM] = { public: [posts], private: [] };
  return ids;
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

  test('downloads several files at once, and still names them in message order', async () => {
    const world = server();
    const ids = Array.from({ length: 8 }, (_, index) => `40000000000000010${index}`);
    for (const [index, id] of ids.entries()) {
      const target = world.messages[TEXT]?.[index + 1];
      assert.ok(target);
      const url = 'https://cdn.test/a';
      target.attachments = [{ id, filename: 'image.png', size: IMAGE.byteLength, url, proxy_url: url, content_type: 'image/png' }];
    }
    const discord = fake(world);
    const { download } = discord;
    let running = 0;
    let most = 0;
    let started = 0;
    discord.download = async (url) => {
      most = Math.max(most, ++running);
      // Later downloads finish sooner, so the files arrive out of order.
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, 40 - 3 * started++)));
      running--;
      return download(url);
    };
    await captureCategory({ discord, categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });

    assert.equal(most, 4);
    const { files } = await readTranscript('case-one');
    // The channel's own messages come first, then its thread's.
    const inOrder = ['400000000000000001', '400000000000000002', ...ids, '400000000000000003'];
    assert.deepEqual(
      inOrder.map((id) => files[id]?.path),
      ['attachments/image.png', ...Array.from({ length: 10 }, (_, index) => `attachments/image (${index + 2}).png`)],
    );
    assert.deepEqual(Object.keys(files), inOrder, 'recorded in message order too');
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
    // Other downloads may have finished meanwhile. The one that failed must leave nothing behind.
    const left = await readdir(join(runDir, 'tree', 'case-one', 'attachments'));
    assert.ok(!left.includes('image.png'), 'the failed file is not kept');
    assert.ok(left.every((name) => !name.endsWith('.part')), 'no partial file left');
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

  test('pages through archived threads without losing ones archived in the same moment', async () => {
    const world = server();
    world.threadPageSize = 3;
    // The 3rd and 4th share an archive time (to the microsecond) and fall either side of the first page.
    const same = '2026-10-04T10:00:00.123456+00:00';
    const ids = archivedPosts(world, ['2026-10-06T10:00:00.000000+00:00', '2026-10-05T10:00:00.000000+00:00', same, same, '2026-10-03T10:00:00.000000+00:00']);
    await run(world);
    const saved = (await readTranscript('appeals')).threads.map((post) => post.channel.id);
    for (const id of ids) assert.ok(saved.includes(id), `post ${id} captured`);
    assert.equal(saved.length, ids.length + 1, 'each post once, plus the active one');
  });

  test('stops rather than skip threads when a whole page was archived in the same moment', async () => {
    const world = server();
    const same = '2026-10-04T10:00:00.000000+00:00';
    archivedPosts(world, [same, same, same]);
    await assert.rejects(run(world), /kept sending the same archived threads/);
  });

  test('asks announcement channels for public threads only, as they cannot have private ones', async () => {
    const world = server();
    const text = world.channels.find((item) => item.id === TEXT);
    assert.ok(text);
    text.type = ChannelType.GuildAnnouncement;
    world.archived[TEXT] = { public: [[channel(MESSAGE_THREAD, ChannelType.AnnouncementThread, 'evidence', TEXT)]], private: [] };
    await run(world);
    assert.ok(world.calls.includes(`archived public ${TEXT}`));
    assert.ok(!world.calls.includes(`archived private ${TEXT}`));
    assert.equal(thread(await readTranscript('case-one'), MESSAGE_THREAD).messages[0]?.content, 'evidence discussion');
  });

  test('stops before writing anything when the bot cannot read message text', async () => {
    const world = server();
    world.appFlags = 0;
    await assert.rejects(run(world), /Message Content Intent is off/);
    await assert.rejects(stat(join(runDir, 'tree')), { code: 'ENOENT' });
    // Apps in 100 or more servers have the other flag.
    world.appFlags = 1 << 18;
    await run(world);
  });

  test('shows the text and images of messages laid out in components', async () => {
    const world = server();
    const laidOut = world.messages[TEXT]?.[5];
    assert.ok(laidOut);
    laidOut.content = '';
    Object.assign(laidOut, {
      components: [
        { type: 1, components: [{ type: 2, label: 'Approve' }] },
        {
          type: 17,
          components: [
            { type: 10, content: '**Match** reported' },
            { type: 12, items: [{ media: { url: 'https://cdn.test/a' } }, { media: { url: 'https://cdn.test/a', attachment_id: '400000000000000009' } }] },
            { type: 9, components: [{ type: 10, content: 'side note' }], accessory: { type: 11, media: { url: 'https://cdn.test/gone' } } },
          ],
        },
      ],
    });
    const result = await run(world);

    const transcript = await readTranscript('case-one');
    assert.ok(transcript.files[`media:${laidOut.id}:0`], 'gallery image saved');
    assert.equal(transcript.files[`media:${laidOut.id}:1`], undefined, 'thumbnail could not be fetched');
    assert.equal(Object.keys(transcript.files).filter((key) => key.startsWith(`media:${laidOut.id}`)).length, 1, 'uploaded image not saved twice');
    assert.ok(result.misses.some((miss) => miss.startsWith(`image in message ${laidOut.id} in #case-one`)));

    const page = await readPage('case-one');
    const article = page.slice(page.indexOf(`id="msg-${laidOut.id}"`), page.indexOf('</article>', page.indexOf(`id="msg-${laidOut.id}"`)));
    assert.match(article, /<strong>Match<\/strong> reported/);
    assert.match(article, /side note/);
    assert.match(article, /Image not archived/);
    assert.doesNotMatch(article, /No text content|Approve/);
  });

  test('shows what a system notice carries, such as an AutoMod alert', async () => {
    const world = server();
    const notice = world.messages[TEXT]?.[6];
    assert.ok(notice);
    Object.assign(notice, { type: 24, content: '', embeds: [{ description: 'flagged words' }] });
    await run(world);
    const page = await readPage('case-one');
    const article = page.slice(page.indexOf(`id="msg-${notice.id}"`), page.indexOf('</article>', page.indexOf(`id="msg-${notice.id}"`)));
    assert.match(article, /system message \(type 24\).*flagged words/s);
  });

  test('rebuilds finished channel pages from their saved record when resuming', async () => {
    const world = server();
    await run(world);
    const page = join(runDir, 'tree', 'case-one', 'case-one.html');
    const built = await readFile(page, 'utf8');
    await writeFile(page, 'stale');
    await run(world);
    assert.equal(await readFile(page, 'utf8'), built);
  });

  test('refuses to capture again once the archive is verified', async () => {
    const world = server();
    await run(world);
    const state = await readState(runDir);
    assert.ok(state);
    state.verification = { status: 'verified', at: '2026-11-22T10:00:00.000Z', checks: [], remote: {} };
    await writeState(runDir, state);
    await assert.rejects(run(world), /already archived and verified/);
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
