import type { APIChannel, APIMessage } from 'discord-api-types/v10';

export const SCHEMA_VERSION = 1;

export interface Person {
  id: string;
  username: string;
  displayName: string;
}

export interface ArchivedFile {
  path: string;
  size: number;
  sha256: string;
  required: boolean;
}

export interface Transcript {
  schema: typeof SCHEMA_VERSION;
  archivedAt: string;
  guild: { id: string; name: string };
  category: { id: string; name: string };
  channel: { id: string; name: string; topic: string | null; raw: APIChannel };
  parent: { name: string; path: string; messageId: string } | null;
  // Exactly as Discord returned them, oldest first.
  messages: APIMessage[];
  resolved: {
    users: Record<string, Person>;
    roles: Record<string, string>;
    channels: Record<string, string>;
    forwardAuthors: Record<string, Person>;
  };
  // Keyed by attachment ID, or by fileKey for embed and sticker images.
  files: Record<string, ArchivedFile>;
  // Thread ID → path of its transcript, relative to this one.
  threads: Record<string, string>;
}

export const fileKey = {
  embed: (prefix: string, index: number) => `embed:${prefix}:${index}`,
  sticker: (stickerId: string) => `sticker:${stickerId}`,
};
