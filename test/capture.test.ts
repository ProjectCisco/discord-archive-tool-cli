import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ChannelType, MessageReferenceType, MessageType } from 'discord-api-types/v10';
import type { APIAttachment, APIMessage } from 'discord-api-types/v10';
import { captureCategory } from '../src/capture.ts';
import type { Discord, GuildChannel } from '../src/discord.ts';
import { parseManifest } from '../src/manifest.ts';
import type { Transcript } from '../src/transcript.ts';

const GUILD = '100000000000000001';
const CATEGORY = '100000000000000002';
const TEXT = '100000000000000003';
const FORUM = '100000000000000004';
const VOICE = '100000000000000005';
const PRIVATE_THREAD = '100000000000000006';
const POST_ACTIVE = '100000000000000007';
const POST_ARCHIVED = '100000000000000008';
const POST_ARCHIVED_OLDER = '100000000000000011';
// Started from message 300000000000000010 in #case-one, so it shares that message's ID.
const MESSAGE_THREAD = '300000000000000010';
const ALICE = { id: '200000000000000001', username: 'alice', global_name: 'Alice', discriminator: '0', avatar: null };

const IMAGE = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function message(id: string, channelId: string, overrides: Partial<APIMessage> = {}): APIMessage {
  return {
    id,
    channel_id: channelId,
    author: ALICE,
    content: `message ${id}`,
    timestamp: '2026-11-01T10:00:00.000000+00:00',
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: MessageType.Default,
    ...overrides,
  } as APIMessage;
}

function channel(id: string, type: number, name: string, parentId: string | null, extra: Partial<GuildChannel> = {}): GuildChannel {
  return { id, type, name, guild_id: GUILD, parent_id: parentId, position: Number(id.slice(-1)), ...extra };
}

interface FakeServer {
  channels: GuildChannel[];
  messages: Record<string, APIMessage[]>;
  activeThreads: GuildChannel[];
  archived: Record<string, { public: GuildChannel[][]; private: GuildChannel[][] }>;
  files: Record<string, Uint8Array>;
  // Response headers per URL. By default a file is served as image/png with its exact Content-Length.
  headers: Record<string, { contentType?: string | null; contentLength?: number | null; encoded?: boolean }>;
  calls: string[];
}

function server(): FakeServer {
  const attachment = (id: string, url: string, size = IMAGE.byteLength) => ({
    id,
    filename: 'image.png',
    size,
    url,
    proxy_url: url,
    content_type: 'image/png',
  });
  // 150 messages forces two pages of 100.
  const textMessages = Array.from({ length: 150 }, (_, index) =>
    message(String(300000000000000000n + BigInt(index)), TEXT),
  );
  textMessages[0] = message('300000000000000000', TEXT, {
    content: '',
    attachments: [attachment('400000000000000001', 'https://cdn.test/a'), attachment('400000000000000002', 'https://cdn.test/expired')],
  });

  return {
    channels: [
      channel(CATEGORY, ChannelType.GuildCategory, 'Archive 2026', null),
      channel(TEXT, ChannelType.GuildText, 'case-one', CATEGORY),
      channel(FORUM, ChannelType.GuildForum, 'appeals', CATEGORY),
      channel(VOICE, ChannelType.GuildVoice, 'hearing', CATEGORY),
      channel('100000000000000009', ChannelType.GuildText, 'general', null),
    ],
    messages: {
      [TEXT]: textMessages,
      [VOICE]: [message('310000000000000001', VOICE, { content: 'voice chat text' })],
      [PRIVATE_THREAD]: [
        message('320000000000000001', PRIVATE_THREAD, {
          content: 'private follow-up',
          attachments: [attachment('400000000000000003', 'https://cdn.test/a')],
        }),
      ],
      [MESSAGE_THREAD]: [message('330000000000000001', MESSAGE_THREAD, { content: 'evidence discussion' })],
      [POST_ACTIVE]: [message(POST_ACTIVE, POST_ACTIVE, { content: 'appeal opened' })],
      [POST_ARCHIVED_OLDER]: [message(POST_ARCHIVED_OLDER, POST_ARCHIVED_OLDER, { content: 'oldest appeal' })],
      [POST_ARCHIVED]: [
        message(POST_ARCHIVED, POST_ARCHIVED, {
          content: '',
          message_reference: { type: MessageReferenceType.Forward, channel_id: TEXT, message_id: '300000000000000005' },
          message_snapshots: [
            {
              message: {
                type: MessageType.Default,
                content: 'forwarded evidence',
                embeds: [],
                attachments: [],
                timestamp: '2026-11-01T10:00:00.000000+00:00',
                edited_timestamp: null,
                mentions: [],
                mention_roles: [],
              },
            },
          ],
        }),
      ],
    },
    activeThreads: [channel(POST_ACTIVE, ChannelType.PublicThread, 'first appeal', FORUM)],
    archived: {
      [TEXT]: {
        public: [[channel(MESSAGE_THREAD, ChannelType.PublicThread, 'evidence', TEXT)]],
        private: [[channel(PRIVATE_THREAD, ChannelType.PrivateThread, 'staff notes', TEXT)]],
      },
      [FORUM]: {
        // Two pages: the tool must follow has_more.
        public: [
          [channel(POST_ARCHIVED, ChannelType.PublicThread, 'old appeal', FORUM)],
          [channel(POST_ARCHIVED_OLDER, ChannelType.PublicThread, 'oldest appeal', FORUM)],
        ],
        private: [],
      },
    },
    files: { 'https://cdn.test/a': IMAGE, 'https://cdn.test/fresh': IMAGE },
    headers: {},
    calls: [],
  };
}

function fake(world: FakeServer): Discord {
  const find = (id: string) => [...world.channels, ...world.activeThreads].find((item) => item.id === id);
  return {
    channel: async (id) => {
      const found = find(id);
      if (!found) throw new Error(`unknown channel ${id}`);
      return found;
    },
    guild: async (id) => ({ id, name: 'Example Server' }),
    guildChannels: async () => world.channels,
    roles: async () => [{ id: '500000000000000001', name: 'Moderators' }] as Awaited<ReturnType<Discord['roles']>>,
    activeThreads: async () => world.activeThreads,
    archivedThreads: async (channelId, kind, before) => {
      const pages = world.archived[channelId]?.[kind] ?? [];
      const index = before === undefined ? 0 : Number(before.replace('page-', ''));
      const threads = (pages[index] ?? []).map((thread) => ({
        ...thread,
        thread_metadata: { archive_timestamp: `page-${index + 1}` },
      }));
      return { threads, has_more: index + 1 < pages.length };
    },
    messagesAfter: async (channelId, after) => {
      world.calls.push(`messages ${channelId} after ${after}`);
      const all = world.messages[channelId] ?? [];
      return all
        .filter((item) => BigInt(item.id) > BigInt(after))
        .slice(0, 100)
        .reverse();
    },
    message: async (channelId, messageId) => {
      world.calls.push(`message ${channelId}/${messageId}`);
      const found = (world.messages[channelId] ?? []).find((item) => item.id === messageId);
      if (!found) return null;
      return {
        ...found,
        attachments: found.attachments.map((item) => (item.url === 'https://cdn.test/expired' ? { ...item, url: 'https://cdn.test/fresh' } : item)),
      };
    },
    member: async (_guildId, userId) =>
      (userId === ALICE.id ? { nick: 'Alice (Mod)' } : null) as Awaited<ReturnType<Discord['member']>>,
    download: async (url) => {
      const bytes = world.files[url];
      if (!bytes) throw new Error('download failed with HTTP 404');
      const body = new Response(bytes).body;
      if (!body) throw new Error('no body');
      const headers = world.headers[url] ?? {};
      return {
        body,
        contentType: headers.contentType === undefined ? 'image/png' : headers.contentType,
        contentLength: headers.contentLength === undefined ? bytes.byteLength : headers.contentLength,
        encoded: headers.encoded ?? false,
      };
    },
  };
}

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'capture-'));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

async function readTranscript(folder: string): Promise<Transcript> {
  return JSON.parse(await readFile(join(runDir, 'tree', folder, `${folder}.json`), 'utf8')) as Transcript;
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

  test('keeps each channel in one folder: the chat page, its data and one attachments folder', async () => {
    await captureCategory({ discord: fake(server()), categoryId: CATEGORY, runDir, operator: 'tester', log: () => {} });
    assert.deepEqual((await readdir(join(runDir, 'tree', 'case-one'))).sort(), ['attachments', 'case-one.html', 'case-one.json']);
    assert.deepEqual((await readdir(join(runDir, 'tree', 'appeals'))).sort(), ['appeals.html', 'appeals.json']);
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
    const manifest = parseManifest(await readFile(join(tree, '_manifest-sha256.txt'), 'utf8'));
    const files = (await readdir(tree, { recursive: true, withFileTypes: true }))
      .filter((item) => item.isFile() && item.name !== '_manifest-sha256.txt')
      .map((item) => join(item.parentPath, item.name).slice(tree.length + 1).split('\\').join('/'));
    assert.deepEqual([...manifest.keys()].sort(), files.sort());
    assert.ok(manifest.has('_index.html'));
    assert.ok(manifest.has('case-one/case-one.html'));
    assert.ok(manifest.has('case-one/attachments/image (3).png'));
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
