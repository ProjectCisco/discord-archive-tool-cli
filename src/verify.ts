import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageType } from 'discord-api-types/v10';
import type { APIAttachment, APIMessage } from 'discord-api-types/v10';
import { listThreads } from './capture.ts';
import { walk } from './archive-folder.ts';
import type { RemoteItem, Store } from './destinations/store.ts';
import type { Discord, GuildChannel } from './discord.ts';
import { explain } from './errors.ts';
import { withRetries } from './http.ts';
import { MANIFEST_PATH, RUN_RECORD_PATH, transcriptPath } from './layout.ts';
import { parseManifest, sha256File } from './manifest.ts';
import { mapParallel } from './parallel.ts';
import type { RunState } from './state.ts';
import type { Conversation, Transcript } from './transcript.ts';

// The four checks an archive has to pass. Delete accepts only an archive where all four passed.
// Every check runs to the end, so one report lists every problem at once.

export interface Check {
  name: string;
  passed: boolean;
  problems: string[];
}

export interface RemoteFile {
  size: number;
  checksum: string | null;
}

export interface VerifyResult {
  passed: boolean;
  checks: Check[];
  // What the destination holds, so delete can re-check it without downloading everything again.
  remote: Record<string, RemoteFile>;
}

export interface VerifyOptions {
  discord: Discord;
  store: Store;
  state: RunState;
  treeDir: string;
  folderId: string;
  log: (line: string) => void;
}

// Discord only keeps an accurate thread message count for threads created from 1 July 2022.
const MESSAGE_COUNT_SINCE = Date.UTC(2022, 6, 1);
const DISCORD_EPOCH = 1420070400000n;

export async function verifyArchive(options: VerifyOptions): Promise<VerifyResult> {
  const { treeDir, log } = options;
  const transcripts = await readTranscripts(treeDir, options.state);
  const manifest = parseManifest(await readFile(join(treeDir, MANIFEST_PATH), 'utf8'));

  log('Check 1/4: nothing new in Discord since capture');
  const capture = await checkCapture(options.discord, options.state, transcripts);
  log('Check 2/4: every file saved at the size Discord reported');
  const files = await checkFiles(treeDir, transcripts, manifest);
  const { store } = options;
  log(`Check 3/4: every file in ${store.label} matches the local copy`);
  const { check: upload, files: remote, folders } = await checkUpload(store, options.folderId, treeDir, manifest);
  log(`Check 4/4: every folder opens in ${store.label}`);
  const reachable = await checkFolders(store, options.folderId, options.state, folders);

  const checks = [capture, files, upload, reachable];
  return { passed: checks.every((check) => check.passed), checks, remote };
}

function check(name: string, problems: string[]): Check {
  return { name, passed: problems.length === 0, problems };
}

export async function readTranscripts(treeDir: string, state: RunState): Promise<Array<{ folder: string; transcript: Transcript }>> {
  const records = Object.values(state.channels);
  const result: Array<{ folder: string; transcript: Transcript }> = [];
  for (const { folder } of records) {
    const text = await readFile(join(treeDir, transcriptPath(folder)), 'utf8');
    result.push({ folder, transcript: JSON.parse(text) as Transcript });
  }
  return result;
}

// Check 1: no channel, thread, post or message appeared after capture, no message is saved twice,
// and no thread holds fewer messages than Discord counts.
export async function checkCapture(
  discord: Discord,
  state: RunState,
  transcripts: Array<{ transcript: Transcript }>,
): Promise<Check> {
  const now = (await discord.guildChannels(state.guildId)).filter((channel) => channel.parent_id === state.categoryId);
  const added = now
    .filter((channel) => !state.channels[channel.id])
    .map((channel) => `#${channel.name} was added to the category after capture`);

  // One lookup per conversation, plus one per channel for its threads. None depends on another,
  // so they run several at a time; the problems still come out in channel order.
  const activeThreads = await discord.activeThreads(state.guildId);
  const lookups: Array<() => Promise<string[]>> = [];
  for (const { transcript } of transcripts) {
    const live = now.find((channel) => channel.id === transcript.channel.id);
    if (!live) continue; // Already gone from Discord: nothing left to delete.

    const conversations: Conversation[] = transcript.kind === 'forum' ? transcript.threads : [transcript, ...transcript.threads];
    for (const conversation of conversations) {
      lookups.push(async () => {
        const problem = savedTwice(conversation) ?? (await newerMessages(discord, conversation));
        return problem ? [problem] : [];
      });
    }
    lookups.push(() => threadProblems(discord, live, activeThreads, transcript));
  }
  const found = await mapParallel(lookups, (lookup) => lookup());
  return check('Complete capture', [...added, ...found.flat()]);
}

async function threadProblems(
  discord: Discord,
  live: GuildChannel,
  activeThreads: GuildChannel[],
  transcript: Transcript,
): Promise<string[]> {
  const problems: string[] = [];
  const saved = new Map(transcript.threads.map((thread) => [thread.channel.id, thread]));
  for (const thread of await listThreads(discord, live, activeThreads)) {
    const captured = saved.get(thread.id);
    const problem = captured ? countMismatch(thread, captured.messages) : `thread "${thread.name}" was created after capture`;
    if (problem) problems.push(`#${transcript.channel.name}: ${problem}`);
  }
  return problems;
}

function savedTwice(conversation: Conversation): string | null {
  const ids = new Set(conversation.messages.map((message) => message.id));
  return ids.size === conversation.messages.length ? null : `#${conversation.channel.name} has a message saved twice`;
}

async function newerMessages(discord: Discord, conversation: Conversation): Promise<string | null> {
  const last = conversation.messages.at(-1)?.id ?? '0';
  try {
    const page = await discord.messagesAfter(conversation.channel.id, last);
    return page.length === 0 ? null : `#${conversation.channel.name} has new messages since capture`;
  } catch (error) {
    return `#${conversation.channel.name} couldn't be read again: ${explain(error)}`;
  }
}

// Discord's count can run low (real threads came back 1 to 3 under what was saved, all normal
// messages, none saved twice), so only fewer saved than counted means something was missed.
function countMismatch(thread: GuildChannel, messages: APIMessage[]): string | null {
  if (thread.message_count === undefined) return null;
  const created = Number((BigInt(thread.id) >> 22n) + DISCORD_EPOCH);
  if (created < MESSAGE_COUNT_SINCE) return null;
  // Discord's count leaves out the thread's first message: a forum post's opening message
  // (same ID as the thread) or the "started a thread" notice.
  const counted = messages.filter(
    (message) => message.id !== thread.id && message.type !== MessageType.ThreadStarterMessage,
  ).length;
  return counted >= thread.message_count
    ? null
    : `thread "${thread.name}": Discord counts ${thread.message_count} messages, the archive has only ${counted}`;
}

// Check 2: every local file still matches the manifest, and every attachment is the size Discord
// reported (or, where Discord records a converted copy, the size noted for it at capture).
async function checkFiles(
  treeDir: string,
  transcripts: Array<{ folder: string; transcript: Transcript }>,
  manifest: Map<string, string>,
): Promise<Check> {
  const problems: string[] = [];
  for (const [path, sha256] of manifest) {
    try {
      if ((await sha256File(join(treeDir, path))) !== sha256) problems.push(`${path} changed since the manifest was written`);
    } catch {
      problems.push(`${path} is missing`);
    }
  }

  for (const { folder, transcript } of transcripts) {
    const attachments = attachmentSizes(transcript);
    for (const [key, file] of Object.entries(transcript.files)) {
      const path = `${folder}/${file.path}`;
      if (manifest.get(path) !== file.sha256) problems.push(`${path} doesn't match its checksum in the manifest`);
      const onDisk = await stat(join(treeDir, path)).then((info) => info.size, () => -1);
      if (onDisk !== file.size) problems.push(`${path} is ${onDisk} bytes on disk, ${file.size} when captured`);
      if (!file.required) continue;
      const reported = attachments.get(key);
      if (reported === undefined) problems.push(`${path} has no matching attachment in the messages`);
      else if (file.size !== reported && file.declaredSize !== reported) {
        problems.push(`${path} is ${file.size} bytes, Discord reported ${reported}`);
      }
    }
  }
  return check('Files downloaded', problems);
}

function attachmentSizes(transcript: Transcript): Map<string, number> {
  const sizes = new Map<string, number>();
  const add = (attachments: APIAttachment[] = []) => {
    for (const attachment of attachments) sizes.set(attachment.id, attachment.size);
  };
  for (const conversation of [transcript, ...transcript.threads]) {
    for (const message of conversation.messages) {
      add(message.attachments);
      add(message.message_snapshots?.[0]?.message.attachments);
    }
  }
  return sizes;
}

// Check 3: every file is at the destination at the right size, and reads back with the same
// SHA-256. The folder holds nothing else, apart from the run record.
async function checkUpload(
  store: Store,
  folderId: string,
  treeDir: string,
  manifest: Map<string, string>,
): Promise<{ check: Check; files: Record<string, RemoteFile>; folders: Map<string, RemoteItem> }> {
  const problems: string[] = [];
  const { files, folders } = await walk(store, folderId);
  const expected = new Map(manifest);
  expected.set(MANIFEST_PATH, await sha256File(join(treeDir, MANIFEST_PATH)));

  const readBack = await mapParallel([...expected], async ([path, sha256]) => {
    const item = files.get(path);
    if (!item) return { path, file: null, problem: `${path} is missing from ${store.label}` };
    const local = await stat(join(treeDir, path)).then((info) => info.size, () => -1);
    const back = await withRetries(() => store.download(item.id));
    let problem: string | null = null;
    if (back.size !== local || item.size !== local) problem = `${path} is ${back.size} bytes in ${store.label}, ${local} locally`;
    else if (back.sha256 !== sha256) problem = `${path} in ${store.label} doesn't match the local copy`;
    return { path, file: { size: back.size, checksum: item.checksum }, problem };
  });
  const remote: Record<string, RemoteFile> = {};
  for (const { path, file, problem } of readBack) {
    if (file) remote[path] = file;
    if (problem) problems.push(problem);
  }

  for (const path of files.keys()) {
    if (path !== RUN_RECORD_PATH && !expected.has(path)) problems.push(`${path} is in ${store.label} but not in the archive`);
  }
  return { check: check('Upload intact', problems), files: remote, folders };
}

// Check 4: the archive folder and every channel folder exist and have an address to open.
async function checkFolders(store: Store, folderId: string, state: RunState, folders: Map<string, RemoteItem>): Promise<Check> {
  const problems: string[] = [];
  const root = await store.item(folderId).catch(() => null);
  if (!root?.webUrl) problems.push(`The archive folder has no address in ${store.label}`);
  for (const { folder } of Object.values(state.channels)) {
    if (!folders.get(folder)?.webUrl) problems.push(`Folder ${folder} has no address in ${store.label}`);
  }
  return check('Folders reachable', problems);
}
