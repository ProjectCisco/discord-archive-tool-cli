import { DiscordAPIError, REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type { APIGuildMember, APIMessage, APIRole } from 'discord-api-types/v10';

// The channel fields this tool reads. The full object is kept as-is in the channel's .json file.
export interface GuildChannel {
  id: string;
  type: number;
  name: string;
  guild_id?: string;
  parent_id?: string | null;
  position?: number;
  topic?: string | null;
  thread_metadata?: { archive_timestamp: string };
  // Threads only: messages in the thread, not counting its first message or deleted ones.
  message_count?: number;
}

export interface Download {
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentType: string | null;
  encoded: boolean;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

// Files are only fetched from Discord's own servers. An embed can point anywhere, including
// addresses inside your own network, so anything else is never requested.
export function isDiscordMedia(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'cdn.discordapp.com' || hostname === 'media.discordapp.net' || /^images-ext-\d+\.discordapp\.net$/.test(hostname));
  } catch {
    return false;
  }
}

export function createDiscord(token: string) {
  const rest = new REST({ version: '10' }).setToken(token);

  const get = (route: `/${string}`, query?: Record<string, string>) =>
    rest.get(route, query ? { query: new URLSearchParams(query) } : {});

  // 403 and 404 both mean the bot cannot see it; each caller decides whether that matters.
  const unlessHidden = async <T>(request: Promise<unknown>): Promise<T | null> => {
    try {
      return (await request) as T;
    } catch (error) {
      if (error instanceof DiscordAPIError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  };

  return {
    channel: async (id: string) => (await get(Routes.channel(id))) as GuildChannel,

    guild: async (id: string) => (await get(Routes.guild(id))) as { id: string; name: string },

    guildChannels: async (guildId: string) => (await get(Routes.guildChannels(guildId))) as GuildChannel[],

    roles: async (guildId: string) => (await get(Routes.guildRoles(guildId))) as APIRole[],

    activeThreads: async (guildId: string) =>
      ((await get(Routes.guildActiveThreads(guildId))) as { threads: GuildChannel[] }).threads,

    archivedThreads: async (channelId: string, kind: 'public' | 'private', before?: string) =>
      (await get(Routes.channelThreads(channelId, kind), before ? { before, limit: '100' } : { limit: '100' })) as {
        threads: GuildChannel[];
        has_more: boolean;
      },

    // Discord returns each page newest first, whichever direction is asked for.
    messagesAfter: async (channelId: string, after: string) =>
      (await get(Routes.channelMessages(channelId), { after, limit: '100' })) as APIMessage[],

    message: (channelId: string, messageId: string) =>
      unlessHidden<APIMessage>(get(Routes.channelMessage(channelId, messageId))),

    member: (guildId: string, userId: string) => unlessHidden<APIGuildMember>(get(Routes.guildMember(guildId, userId))),

    // Deletes one channel, with its threads. The reason appears in the server's audit log.
    // "gone" means it was already deleted; any other error, including no permission, is thrown.
    deleteChannel: async (channelId: string, reason: string): Promise<'deleted' | 'gone'> => {
      try {
        await rest.delete(Routes.channel(channelId), { reason: reason.slice(0, 512) });
        return 'deleted';
      } catch (error) {
        if (error instanceof DiscordAPIError && error.status === 404) return 'gone';
        throw error;
      }
    },

    // Mentions are switched off: a log post must never ping anyone.
    post: async (channelId: string, content: string) => {
      await rest.post(Routes.channelMessages(channelId), { body: { content, allowed_mentions: { parse: [] } } });
    },

    // Attachment URLs are signed and expire, so they are never logged.
    download: async (url: string): Promise<Download> => {
      if (!isDiscordMedia(url)) throw new Error('not hosted by Discord, so not downloaded');
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!isDiscordMedia(response.url)) {
        await response.body?.cancel();
        throw new Error('redirected away from Discord, so not downloaded');
      }
      if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
      const length = response.headers.get('content-length');
      return {
        body: response.body,
        contentLength: length === null ? null : Number(length),
        contentType: response.headers.get('content-type'),
        // fetch decompresses encoded bodies, so Content-Length then no longer describes the bytes received.
        encoded: response.headers.has('content-encoding'),
      };
    },
  };
}

export type Discord = ReturnType<typeof createDiscord>;
