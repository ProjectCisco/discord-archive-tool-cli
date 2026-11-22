import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ChannelType, MessageReferenceType, MessageType, StickerFormatType } from 'discord-api-types/v10';
import type { APIAttachment, APIMessage, APIUser } from 'discord-api-types/v10';
import type { Discord, Download, GuildChannel } from './discord.ts';
import { explain } from './errors.ts';
import { DATA_DIR, INDEX_NAME, transcriptPath } from './layout.ts';
import { writeManifest } from './manifest.ts';
import { claimFileName, claimFolderName, safeName } from './names.ts';
import { renderCategoryIndex, renderTranscript } from './render.ts';
import { STATE_SCHEMA, readState, writeFileAtomic, writeState, type CapturedChannel, type RunState } from './state.ts';
import { count } from './text.ts';
import { SCHEMA_VERSION, fileKey, type ArchivedFile, type Conversation, type Person, type Thread, type Transcript } from './transcript.ts';

const MESSAGE_CHANNELS = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);
const THREAD_PARENTS = new Set<number>([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const FORUM_CHANNELS = new Set<number>([ChannelType.GuildForum, ChannelType.GuildMedia]);
// Ceilings that stop a bad or hostile server filling the disk. Discord's largest upload is 500 MiB;
// a served original can be bigger than Discord's record (decision D32), hence the headroom.
const MAX_ATTACHMENT_BYTES = 1024 ** 3;
const MAX_BEST_EFFORT_BYTES = 50 * 1024 ** 2;

export interface CaptureOptions {
  discord: Discord;
  categoryId: string;
  runDir: string;
  operator: string;
  log: (line: string) => void;
}

export interface CaptureResult {
  treeDir: string;
  categoryName: string;
  channels: number;
  messages: number;
  files: number;
  converted: number;
  misses: string[];
}

interface Context {
  discord: Discord;
  treeDir: string;
  guild: { id: string; name: string };
  category: { id: string; name: string };
  archivedAt: string;
  roles: Record<string, string>;
  channelNames: Record<string, string>;
  people: Map<string, Person>;
}

// Everything saved for one top-level channel goes in its single attachments folder.
interface Files {
  dir: string;
  taken: Set<string>;
  saved: Record<string, ArchivedFile>;
  misses: string[];
}

export async function captureCategory(options: CaptureOptions): Promise<CaptureResult> {
  const { discord, categoryId, runDir, log } = options;

  const category = await discord.channel(categoryId);
  if (category.type !== ChannelType.GuildCategory || !category.guild_id) {
    throw new Error(`${categoryId} is not a server category`);
  }
  const guild = await discord.guild(category.guild_id);
  const allChannels = await discord.guildChannels(guild.id);
  const children = allChannels
    .filter((channel) => channel.parent_id === category.id)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  // A channel this tool can't archive must never be deleted with the rest, so stop before writing anything.
  const unsupported = children.filter((channel) => !MESSAGE_CHANNELS.has(channel.type) && !FORUM_CHANNELS.has(channel.type));
  if (unsupported.length > 0) {
    const names = unsupported.map((channel) => `#${channel.name} (type ${channel.type})`).join(', ');
    throw new Error(`Can't archive these channels: ${names}. Move them out of the category and run again.`);
  }

  const existing = await readState(runDir);
  if (existing && existing.categoryId !== category.id) {
    throw new Error(`${runDir} belongs to category ${existing.categoryId}, not ${category.id}`);
  }
  const state: RunState = existing ?? {
    schema: STATE_SCHEMA,
    guildId: guild.id,
    categoryId: category.id,
    categoryName: category.name,
    startedAt: new Date().toISOString(),
    channels: {},
  };

  const treeDir = join(runDir, 'tree');
  await mkdir(join(treeDir, DATA_DIR), { recursive: true });

  const activeThreads = await discord.activeThreads(guild.id);
  const context: Context = {
    discord,
    treeDir,
    guild: { id: guild.id, name: guild.name },
    category: { id: category.id, name: category.name },
    archivedAt: state.startedAt,
    roles: Object.fromEntries((await discord.roles(guild.id)).map((role) => [role.id, role.name])),
    channelNames: Object.fromEntries([...allChannels, ...activeThreads].map((channel) => [channel.id, channel.name])),
    people: new Map(),
  };

  // _data is the tool's own folder, so no channel may take that name.
  const taken = new Set([DATA_DIR, ...Object.values(state.channels).map((done) => done.folder.toLowerCase())]);
  for (const [index, channel] of children.entries()) {
    const progress = `[${index + 1}/${children.length}] #${channel.name}`;
    const done = state.channels[channel.id];
    if (done) {
      log(`${progress}: already captured`);
      continue;
    }

    const folder = claimFolderName(channel.name, channel.id, taken);
    const dir = join(treeDir, folder);
    // Anything left by an unfinished earlier attempt is thrown away, so nothing stale mixes in.
    await rm(dir, { recursive: true, force: true });
    await rm(join(treeDir, transcriptPath(folder)), { force: true });

    const record = await captureChannel(context, channel, folder, dir, activeThreads);
    state.channels[channel.id] = record;
    await writeState(runDir, state);
    const { messages, files, threads } = record.entry;
    log(`${progress}: ${count(messages, 'message')}, ${count(files, 'file')}, ${count(threads, 'thread or post', 'threads or posts')}`);
  }

  const records = children.flatMap((channel) => state.channels[channel.id] ?? []);
  const misses = records.flatMap((record) => record.misses);
  const converted = records.reduce((sum, record) => sum + record.converted, 0);
  await writeFileAtomic(
    join(treeDir, INDEX_NAME),
    renderCategoryIndex({
      guildName: guild.name,
      categoryName: category.name,
      categoryId: category.id,
      archivedAt: state.startedAt,
      operator: options.operator,
      entries: records.map((record) => record.entry),
      converted,
      misses,
    }),
  );
  await writeManifest(treeDir);

  return {
    treeDir,
    categoryName: category.name,
    channels: records.length,
    messages: records.reduce((sum, record) => sum + record.entry.messages, 0),
    files: records.reduce((sum, record) => sum + record.entry.files, 0),
    converted,
    misses,
  };
}

async function captureChannel(
  context: Context,
  channel: GuildChannel,
  folder: string,
  dir: string,
  activeThreads: GuildChannel[],
): Promise<CapturedChannel> {
  const isForum = FORUM_CHANNELS.has(channel.type);
  const threadChannels = await listThreads(context.discord, channel, activeThreads);
  for (const thread of threadChannels) context.channelNames[thread.id] = thread.name;

  await mkdir(dir, { recursive: true });
  const files: Files = { dir, taken: new Set(), saved: {}, misses: [] };
  const messages = isForum ? [] : await captureMessages(context, channel, files);

  const threads: Thread[] = [];
  for (const thread of threadChannels) {
    threads.push({
      ...conversation(thread, await captureMessages(context, thread, files)),
      startMessageId: isForum ? null : startMessage(thread, messages),
    });
  }

  const everything = [...messages, ...threads.flatMap((thread) => thread.messages)];
  const transcript: Transcript = {
    schema: SCHEMA_VERSION,
    kind: isForum ? 'forum' : 'channel',
    archivedAt: context.archivedAt,
    guild: context.guild,
    category: context.category,
    ...conversation(channel, messages),
    threads,
    resolved: {
      users: await resolveUsers(context, everything),
      roles: context.roles,
      channels: context.channelNames,
      forwardAuthors: await forwardAuthors(context, everything),
    },
    files: files.saved,
  };
  await writeFileAtomic(join(context.treeDir, transcriptPath(folder)), JSON.stringify(transcript, null, 2));
  await writeFileAtomic(join(dir, `${folder}.html`), renderTranscript(transcript));

  const saved = Object.values(files.saved);
  return {
    folder,
    entry: {
      name: channel.name,
      path: `${folder}/${folder}.html`,
      messages: everything.length,
      files: saved.filter((file) => file.required).length,
      threads: threads.length,
    },
    converted: saved.filter((file) => file.declaredSize !== undefined).length,
    misses: files.misses,
  };
}

function conversation(channel: GuildChannel, messages: APIMessage[]): Conversation {
  return { channel: { id: channel.id, name: channel.name, topic: channel.topic ?? null, raw: channel }, messages };
}

// A thread started from a message shares that message's ID. One started on its own
// leaves a "started a thread" notice in the parent that points at it.
function startMessage(thread: GuildChannel, parentMessages: APIMessage[]): string | null {
  const start = parentMessages.find(
    (message) =>
      message.id === thread.id ||
      (message.type === MessageType.ThreadCreated && message.message_reference?.channel_id === thread.id),
  );
  return start?.id ?? null;
}

async function captureMessages(context: Context, channel: GuildChannel, files: Files): Promise<APIMessage[]> {
  const messages: APIMessage[] = [];
  // Page forward from the very first message. Only an empty page ends the loop: no silent truncation.
  for (let after = '0'; ; ) {
    const page = (await context.discord.messagesAfter(channel.id, after)).sort(byId);
    const last = page.at(-1);
    if (!last) return messages;
    for (const message of page) {
      await saveFiles(context, channel, message, files);
      messages.push(message);
    }
    after = last.id;
  }
}

async function resolveUsers(context: Context, messages: APIMessage[]): Promise<Record<string, Person>> {
  const users = new Map<string, APIUser>();
  for (const message of messages) {
    users.set(message.author.id, message.author);
    for (const mentioned of message.mentions) users.set(mentioned.id, mentioned);
    if (message.referenced_message) users.set(message.referenced_message.author.id, message.referenced_message.author);
  }
  const resolved: Record<string, Person> = {};
  for (const user of users.values()) resolved[user.id] = await person(context, user);
  return resolved;
}

// A forward's snapshot leaves out who wrote the original, so look it up where it still exists.
async function forwardAuthors(context: Context, messages: APIMessage[]): Promise<Record<string, Person>> {
  const authors: Record<string, Person> = {};
  for (const message of messages) {
    const reference = message.message_reference;
    if (reference?.type !== MessageReferenceType.Forward || !reference.channel_id || !reference.message_id) continue;
    const original = await context.discord.message(reference.channel_id, reference.message_id);
    if (original) authors[message.id] = await person(context, original.author);
  }
  return authors;
}

async function saveFiles(context: Context, channel: GuildChannel, message: APIMessage, files: Files): Promise<void> {
  const snapshot = message.message_snapshots?.[0]?.message;
  for (const attachment of [...message.attachments, ...(snapshot?.attachments ?? [])]) {
    const path = `attachments/${claimFileName(attachment.filename, files.taken)}`;
    files.saved[attachment.id] = await saveAttachment(context, channel, message.id, attachment, join(files.dir, path), path);
  }

  const embedSets = [
    { prefix: message.id, embeds: message.embeds },
    { prefix: `${message.id}:forward`, embeds: snapshot?.embeds ?? [] },
  ];
  for (const { prefix, embeds } of embedSets) {
    for (const [index, embed] of embeds.entries()) {
      const media = embed.image ?? embed.thumbnail;
      const url = media?.proxy_url ?? media?.url;
      if (!url) continue;
      const label = `embed image in message ${message.id} in #${channel.name}`;
      const saved = await saveBestEffort(context, url, files, `embed-${index + 1}${imageExtension(url)}`);
      if (typeof saved === 'string') files.misses.push(`${label} (${saved})`);
      else files.saved[fileKey.embed(prefix, index)] = saved;
    }
  }

  for (const sticker of message.sticker_items ?? []) {
    const label = `sticker "${sticker.name}" in message ${message.id} in #${channel.name}`;
    if (sticker.format_type === StickerFormatType.Lottie) {
      files.misses.push(`${label} (animated sticker format, can't be saved as an image)`);
      continue;
    }
    const extension = sticker.format_type === StickerFormatType.GIF ? '.gif' : '.png';
    const url = `https://media.discordapp.net/stickers/${sticker.id}${extension}`;
    const saved = await saveBestEffort(context, url, files, `sticker-${safeName(sticker.name)}${extension}`);
    if (typeof saved === 'string') files.misses.push(`${label} (${saved})`);
    else files.saved[fileKey.sticker(sticker.id)] = saved;
  }
}

// Required: a file that can't be downloaded at Discord's stated size stops the run, so nothing is deleted.
async function saveAttachment(
  context: Context,
  channel: GuildChannel,
  messageId: string,
  attachment: APIAttachment,
  target: string,
  path: string,
): Promise<ArchivedFile> {
  const expected = { size: attachment.size, contentType: attachment.content_type ?? null };
  const attempt = async (url: string): Promise<ArchivedFile> => {
    const saved = await download(context.discord, url, target, expected);
    return saved.size === attachment.size
      ? { path, size: saved.size, sha256: saved.sha256, required: true }
      : { path, size: saved.size, sha256: saved.sha256, required: true, declaredSize: attachment.size };
  };

  try {
    return await attempt(attachment.url);
  } catch {
    // Signed URLs expire; fetching the message again gives fresh ones.
    const fresh = await context.discord.message(channel.id, messageId);
    const candidates = [...(fresh?.attachments ?? []), ...(fresh?.message_snapshots?.[0]?.message.attachments ?? [])];
    const renewed = candidates.find((candidate) => candidate.id === attachment.id);
    if (!renewed) throw new Error(`"${attachment.filename}" in message ${messageId} in #${channel.name} is no longer available`);
    try {
      return await attempt(renewed.url);
    } catch (error) {
      throw new Error(
        `Couldn't download "${attachment.filename}" from message ${messageId} in #${channel.name}: ${explain(error)}`,
      );
    }
  }
}

// Returns why, when the file couldn't be saved. A miss is listed in _index.html, never silent.
async function saveBestEffort(context: Context, url: string, files: Files, name: string): Promise<ArchivedFile | string> {
  const path = `attachments/${claimFileName(name, files.taken)}`;
  try {
    const saved = await download(context.discord, url, join(files.dir, path), null);
    return { path, size: saved.size, sha256: saved.sha256, required: false };
  } catch (error) {
    return explain(error);
  }
}

interface Expected {
  size: number;
  contentType: string | null;
}

async function download(
  discord: Discord,
  url: string,
  target: string,
  expected: Expected | null,
): Promise<{ size: number; sha256: string }> {
  const partial = `${target}.part`;
  const hash = createHash('sha256');
  let size = 0;

  await mkdir(dirname(target), { recursive: true });
  try {
    const response = await discord.download(url);
    await pipeline(
      response.body,
      async function* (source: AsyncIterable<Uint8Array>) {
        const limit = expected ? MAX_ATTACHMENT_BYTES : MAX_BEST_EFFORT_BYTES;
        for await (const chunk of source) {
          size += chunk.byteLength;
          if (size > limit) throw new Error(`larger than ${limit / 1024 ** 2} MiB, so not saved`);
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(partial),
    );
    if (expected && size !== expected.size && !isConvertedCopy(expected, response, size)) {
      const served = response.contentType ? ` (${response.contentType})` : '';
      const declared = expected.contentType ? ` (${expected.contentType})` : '';
      throw new Error(`got ${size} bytes${served}, Discord says ${expected.size}${declared}`);
    }
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }

  await rename(partial, target);
  return { size, sha256: hash.digest('hex') };
}

// Discord may record a converted copy (e.g. WebP) of an upload while serving the original bytes.
// Accept the served file only if the server stated its length, all of it arrived, and it is the
// same kind of content Discord recorded, so a truncated file or an error page can never pass.
function isConvertedCopy(expected: Expected, response: Download, size: number): boolean {
  const kind = (contentType: string | null) => contentType?.split('/')[0]?.trim().toLowerCase() || null;
  const fullyReceived = response.contentLength !== null && !response.encoded && size === response.contentLength;
  const sameKind = kind(expected.contentType) !== null && kind(expected.contentType) === kind(response.contentType);
  return fullyReceived && sameKind;
}

// Every thread or forum post under a channel, active and archived. Verify and delete use this too,
// so they see exactly what capture saw.
export async function listThreads(discord: Discord, channel: GuildChannel, activeThreads: GuildChannel[]): Promise<GuildChannel[]> {
  const isForum = FORUM_CHANNELS.has(channel.type);
  if (!isForum && !THREAD_PARENTS.has(channel.type)) return [];
  return dedupe([
    ...activeThreads.filter((thread) => thread.parent_id === channel.id),
    ...(await archivedThreads(discord, channel.id, 'public')),
    // Forum posts are always public.
    ...(isForum ? [] : await archivedThreads(discord, channel.id, 'private')),
  ]);
}

async function archivedThreads(discord: Discord, channelId: string, kind: 'public' | 'private'): Promise<GuildChannel[]> {
  const threads: GuildChannel[] = [];
  for (let before: string | undefined; ; ) {
    const page = await discord.archivedThreads(channelId, kind, before);
    threads.push(...page.threads);
    if (!page.has_more) return threads;
    before = page.threads.at(-1)?.thread_metadata?.archive_timestamp;
    if (!before) throw new Error(`Discord reported more archived threads in ${channelId} but gave no point to continue from`);
  }
}

async function person(context: Context, user: APIUser): Promise<Person> {
  const known = context.people.get(user.id);
  if (known) return known;
  const member = await context.discord.member(context.guild.id, user.id);
  const resolved = { id: user.id, username: user.username, displayName: member?.nick ?? user.global_name ?? user.username };
  context.people.set(user.id, resolved);
  return resolved;
}

function dedupe(channels: GuildChannel[]): GuildChannel[] {
  return [...new Map(channels.map((channel) => [channel.id, channel])).values()].sort(byId);
}

function byId(a: { id: string }, b: { id: string }): number {
  const left = BigInt(a.id);
  const right = BigInt(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
}

function imageExtension(url: string): string {
  const extension = extname(new URL(url).pathname).toLowerCase();
  return /^\.(png|jpe?g|gif|webp|avif)$/.test(extension) ? extension : '.png';
}
