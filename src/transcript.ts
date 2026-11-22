import type { APIMessage } from 'discord-api-types/v10';

export const SCHEMA_VERSION = 1;

export interface Person {
  id: string;
  username: string;
  displayName: string;
}

export interface ArchivedFile {
  // Relative to the channel's folder, e.g. "attachments/image (2).png".
  path: string;
  size: number;
  sha256: string;
  required: boolean;
  // Discord's recorded size, kept only when it differs from the file Discord served.
  // Discord can record a converted copy (e.g. WebP) while serving the original upload.
  declaredSize?: number;
}

export interface Conversation {
  // `raw` is the channel object exactly as Discord returned it.
  channel: { id: string; name: string; topic: string | null; raw: unknown };
  // Exactly as Discord returned them, oldest first.
  messages: APIMessage[];
}

export interface Thread extends Conversation {
  // The message in the parent channel that started this thread, if any.
  startMessageId: string | null;
}

// One transcript per top-level channel. A text channel's threads and a forum's posts live inside it,
// so a channel's folder holds one page, one data file and its attachments.
export interface Transcript extends Conversation {
  schema: typeof SCHEMA_VERSION;
  kind: 'channel' | 'forum';
  archivedAt: string;
  guild: { id: string; name: string };
  category: { id: string; name: string };
  // Threads of a text channel, or the posts of a forum.
  threads: Thread[];
  resolved: {
    users: Record<string, Person>;
    roles: Record<string, string>;
    channels: Record<string, string>;
    forwardAuthors: Record<string, Person>;
  };
  // Keyed by attachment ID, or by fileKey for embed and sticker images.
  files: Record<string, ArchivedFile>;
}

export const fileKey = {
  embed: (prefix: string, index: number) => `embed:${prefix}:${index}`,
  sticker: (stickerId: string) => `sticker:${stickerId}`,
};
