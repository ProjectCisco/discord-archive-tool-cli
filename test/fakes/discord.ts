import { ChannelType, MessageReferenceType, MessageType } from 'discord-api-types/v10';
import type { APIMessage } from 'discord-api-types/v10';
import type { Discord, GuildChannel } from '../../src/discord.ts';

// A small Discord server for tests: a text channel with two pages of messages and two threads,
// a forum with three posts across two pages of archived threads, and a voice channel.

export const GUILD = '100000000000000001';
export const CATEGORY = '100000000000000002';
export const TEXT = '100000000000000003';
export const FORUM = '100000000000000004';
export const VOICE = '100000000000000005';
export const PRIVATE_THREAD = '100000000000000006';
export const POST_ACTIVE = '100000000000000007';
export const POST_ARCHIVED = '100000000000000008';
export const POST_ARCHIVED_OLDER = '100000000000000011';
// Started from message 300000000000000010 in #case-one, so it shares that message's ID.
export const MESSAGE_THREAD = '300000000000000010';
export const ALICE = { id: '200000000000000001', username: 'alice', global_name: 'Alice', discriminator: '0', avatar: null };

export const IMAGE = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

export function message(id: string, channelId: string, overrides: Partial<APIMessage> = {}): APIMessage {
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

export function channel(id: string, type: number, name: string, parentId: string | null, extra: Partial<GuildChannel> = {}): GuildChannel {
  return { id, type, name, guild_id: GUILD, parent_id: parentId, position: Number(id.slice(-1)), ...extra };
}

export interface FakeServer {
  channels: GuildChannel[];
  messages: Record<string, APIMessage[]>;
  activeThreads: GuildChannel[];
  archived: Record<string, { public: GuildChannel[][]; private: GuildChannel[][] }>;
  files: Record<string, Uint8Array>;
  // Response headers per URL. By default a file is served as image/png with its exact Content-Length.
  headers: Record<string, { contentType?: string | null; contentLength?: number | null; encoded?: boolean }>;
  calls: string[];
  // Channel IDs the bot isn't allowed to delete.
  protected?: string[];
  // The bot application's flags. Defaults to Message Content Intent on (fewer than 100 servers).
  appFlags?: number;
  // Archived threads per page. Discord sends up to 100; the default of 2 keeps pages small.
  threadPageSize?: number;
}

export function server(): FakeServer {
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

export function fake(world: FakeServer): Discord {
  const find = (id: string) => [...world.channels, ...world.activeThreads].find((item) => item.id === id);
  return {
    channel: async (id) => {
      const found = find(id);
      if (!found) throw new Error(`unknown channel ${id}`);
      return found;
    },
    application: async () => ({ flags: world.appFlags ?? 1 << 19 }),
    guild: async (id) => ({ id, name: 'Example Server' }),
    guildChannels: async () => world.channels,
    roles: async () => [{ id: '500000000000000001', name: 'Moderators' }] as Awaited<ReturnType<Discord['roles']>>,
    activeThreads: async () => world.activeThreads,
    // As Discord does: newest archived first, only those archived strictly before `before`.
    archivedThreads: async (channelId, kind, before) => {
      world.calls.push(`archived ${kind} ${channelId}`);
      // A paging loop that never ends fails here instead of hanging the tests.
      if (world.calls.filter((call) => call === `archived ${kind} ${channelId}`).length > 50) throw new Error('fake: too many pages');
      const time = (thread: GuildChannel) => Date.parse(thread.thread_metadata?.archive_timestamp ?? '');
      const older = (world.archived[channelId]?.[kind] ?? [])
        .flat()
        .map((thread, index) => ({
          thread_metadata: { archive_timestamp: new Date(Date.UTC(2026, 9, 30) - index * 60_000).toISOString() },
          ...thread,
        }))
        .filter((thread) => before === undefined || time(thread) < Date.parse(before))
        .sort((a, b) => time(b) - time(a));
      const size = world.threadPageSize ?? 2;
      return { threads: older.slice(0, size), has_more: older.length > size };
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
    deleteChannel: async (channelId, reason) => {
      world.calls.push(`delete ${channelId}: ${reason}`);
      if (world.protected?.includes(channelId)) throw new Error('Missing Permissions');
      const index = world.channels.findIndex((item) => item.id === channelId);
      if (index === -1) return 'gone';
      world.channels.splice(index, 1);
      world.activeThreads = world.activeThreads.filter((thread) => thread.parent_id !== channelId);
      delete world.archived[channelId];
      delete world.messages[channelId];
      return 'deleted';
    },
    post: async (channelId, content) => {
      world.calls.push(`post ${channelId}: ${content}`);
    },
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
