import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ChannelType, MessageReferenceType, MessageType, StickerFormatType } from 'discord-api-types/v10';
import type { APIAttachment, APIMessage, APIUser } from 'discord-api-types/v10';
import { componentContent } from './components.ts';
import type { Discord, Download, GuildChannel } from './discord.ts';
import { explain } from './errors.ts';
import { DATA_DIR, INDEX_NAME, transcriptPath } from './layout.ts';
import { writeManifest } from './manifest.ts';
import { claimFileName, claimFolderName, safeName } from './names.ts';
import { mapParallel } from './parallel.ts';
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
// The bot's Message Content Intent, as the flag Discord sets for apps in 100+ servers or in fewer.
// Without it, Discord sends every message with empty text and no error.
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);
const FORUM_CHANNELS = new Set<number>([ChannelType.GuildForum, ChannelType.GuildMedia]);
// Ceilings that stop a bad or hostile server filling the disk. Discord's largest upload is 500 MiB;
// a served original can be bigger than Discord's record (see isConvertedCopy), hence the headroom.
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
  // See claimFileName.
  taken: Map<string, number>;
}

// One file to download.
interface FileJob {
  // Where the file is recorded in the transcript's `files`.
  key: string;
  // Best-effort files only: what _index.html lists if the file can't be saved. Without a label,
  // a failure stops the run, so nothing is deleted.
  label?: string;
  save: () => Promise<ArchivedFile>;
}

export async function captureCategory(options: CaptureOptions): Promise<CaptureResult> {
  const { discord, categoryId, runDir, log } = options;

  const category = await discord.channel(categoryId);
  if (category.type !== ChannelType.GuildCategory || !category.guild_id) {
    throw new Error(`${categoryId} is not a server category`);
  }
  const application = await discord.application();
  if (((application.flags ?? 0) & MESSAGE_CONTENT_FLAGS) === 0) {
    throw new Error(
      "The bot's Message Content Intent is off, so Discord would send every message without its text. Turn it on in the Developer Portal (your app → Bot → Message Content Intent) and run again.",
    );
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
  // A verified copy is final: changing it would make it differ from what was checked.
  if (existing?.verification?.status === 'verified') throw new Error(`${runDir} is already archived and verified`);
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
      // Rebuilt from the saved record, so the page always shows everything the record holds.
      const transcript = JSON.parse(await readFile(join(treeDir, transcriptPath(done.folder)), 'utf8')) as Transcript;
      await writeFileAtomic(join(treeDir, done.folder, `${done.folder}.html`), renderTranscript(transcript));
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
  const files: Files = { dir, taken: new Map() };
  const jobs: FileJob[] = [];
  const read = async (source: GuildChannel) => {
    const messages = await readMessages(context.discord, source.id);
    for (const message of messages) jobs.push(...fileJobs(context, source, message, files));
    return messages;
  };

  const messages = isForum ? [] : await read(channel);
  const threads: Thread[] = [];
  for (const thread of threadChannels) {
    threads.push({ ...conversation(thread, await read(thread)), startMessageId: isForum ? null : startMessage(thread, messages) });
  }
  const { saved, misses } = await saveFiles(jobs);

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
    files: saved,
  };
  await writeFileAtomic(join(context.treeDir, transcriptPath(folder)), JSON.stringify(transcript, null, 2));
  await writeFileAtomic(join(dir, `${folder}.html`), renderTranscript(transcript));

  const archived = Object.values(saved);
  return {
    folder,
    entry: {
      name: channel.name,
      path: `${folder}/${folder}.html`,
      messages: everything.length,
      files: archived.filter((file) => file.required).length,
      threads: threads.length,
    },
    converted: archived.filter((file) => file.declaredSize !== undefined).length,
    misses,
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

async function readMessages(discord: Discord, channelId: string): Promise<APIMessage[]> {
  const messages: APIMessage[] = [];
  // Page forward from the very first message. Only an empty page ends the loop: no silent truncation.
  for (let after = '0'; ; ) {
    const page = (await discord.messagesAfter(channelId, after)).sort(byId);
    const last = page.at(-1);
    if (!last) return messages;
    messages.push(...page);
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

// Every file one message needs. Names are claimed here, in message order, so a file's name never
// depends on which download finishes first.
function fileJobs(context: Context, channel: GuildChannel, message: APIMessage, files: Files): FileJob[] {
  const jobs: FileJob[] = [];
  const claim = (name: string) => `attachments/${claimFileName(name, files.taken)}`;
  const bestEffort = (key: string, label: string, url: string, name: string) => {
    const path = claim(name);
    const save = async () => ({ path, ...(await download(context.discord, url, join(files.dir, path), null)), required: false });
    jobs.push({ key, label, save });
  };

  const snapshot = message.message_snapshots?.[0]?.message;
  for (const attachment of [...message.attachments, ...(snapshot?.attachments ?? [])]) {
    const path = claim(attachment.filename);
    jobs.push({ key: attachment.id, save: () => saveAttachment(context, channel, message.id, attachment, join(files.dir, path), path) });
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
      bestEffort(fileKey.embed(prefix, index), label, url, `embed-${index + 1}${imageExtension(url)}`);
    }
  }

  for (const sticker of message.sticker_items ?? []) {
    const key = fileKey.sticker(sticker.id);
    const label = `sticker "${sticker.name}" in message ${message.id} in #${channel.name}`;
    if (sticker.format_type === StickerFormatType.Lottie) {
      jobs.push({ key, label, save: () => Promise.reject(new Error("animated sticker format, can't be saved as an image")) });
      continue;
    }
    const extension = sticker.format_type === StickerFormatType.GIF ? '.gif' : '.png';
    bestEffort(key, label, `https://media.discordapp.net/stickers/${sticker.id}${extension}`, `sticker-${safeName(sticker.name)}${extension}`);
  }

  for (const [index, media] of componentContent(message).media.entries()) {
    const url = media.proxy_url ?? media.url;
    const label = `image in message ${message.id} in #${channel.name}`;
    bestEffort(fileKey.media(message.id, index), label, url, `image-${index + 1}${imageExtension(url)}`);
  }
  return jobs;
}

// Downloads a channel's files, several at a time. A best-effort file that can't be saved becomes a
// line for _index.html, never a silent gap; any other failure is thrown.
async function saveFiles(jobs: FileJob[]): Promise<{ saved: Record<string, ArchivedFile>; misses: string[] }> {
  const outcomes = await mapParallel(jobs, async ({ key, label, save }) => {
    try {
      return { key, file: await save() };
    } catch (error) {
      if (label === undefined) throw error;
      return { miss: `${label} (${explain(error)})` };
    }
  });

  const saved: Record<string, ArchivedFile> = {};
  const misses: string[] = [];
  for (const outcome of outcomes) {
    if ('miss' in outcome) misses.push(outcome.miss);
    else saved[outcome.key] = outcome.file;
  }
  return { saved, misses };
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
    // Only text channels have private threads. Forum posts and announcement threads are always public.
    ...(channel.type === ChannelType.GuildText ? await archivedThreads(discord, channel.id, 'private') : []),
  ]);
}

async function archivedThreads(discord: Discord, channelId: string, kind: 'public' | 'private'): Promise<GuildChannel[]> {
  const threads = new Map<string, GuildChannel>();
  for (let before: string | undefined; ; ) {
    const page = await discord.archivedThreads(channelId, kind, before);
    const added = page.threads.filter((thread) => !threads.has(thread.id)).length;
    for (const thread of page.threads) threads.set(thread.id, thread);
    if (!page.has_more) return [...threads.values()];
    before = justAfterOldest(page.threads);
    if (!before) throw new Error(`Discord reported more archived threads in ${channelId} but gave no point to continue from`);
    if (added === 0) throw new Error(`Discord kept sending the same archived threads in ${channelId}, so the rest can't be reached`);
  }
}

// Discord pages archived threads by archive time, returning those archived before the time given.
// Threads archived in the same moment as the page's oldest could fall between pages, so the next
// page starts just after it; threads seen twice are kept once.
function justAfterOldest(threads: GuildChannel[]): string | undefined {
  const times = threads.map((thread) => Date.parse(thread.thread_metadata?.archive_timestamp ?? ''));
  if (times.length === 0 || times.some(Number.isNaN)) return undefined;
  return new Date(Math.min(...times) + 1).toISOString();
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
  // URL.parse returns null for a malformed URL; the download then refuses it and records a miss.
  const extension = extname(URL.parse(url)?.pathname ?? '').toLowerCase();
  return /^\.(png|jpe?g|gif|webp|avif)$/.test(extension) ? extension : '.png';
}
