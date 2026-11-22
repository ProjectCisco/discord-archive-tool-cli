import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUN_RECORD, readRunRecord } from './destinations/onedrive.ts';
import type { Discord } from './discord.ts';
import type { Graph } from './graph.ts';
import { MANIFEST_NAME, parseManifest } from './manifest.ts';
import type { RunState } from './state.ts';
import { checkCapture, readTranscripts, walk } from './verify.ts';

// The delete command's safety net (design section 7). Deleting can't be undone, so everything
// verify proved is proved again, minutes before, and any doubt means nothing is deleted.

export interface Recheck {
  problems: string[];
}

export interface RecheckOptions {
  discord: Discord;
  graph: Graph;
  state: RunState;
  treeDir: string;
}

// Why delete would refuse this run before looking at Discord or OneDrive at all.
export function refusal(state: RunState | null): string | null {
  if (!state) return 'No archive of this category exists on this computer. Run archive first.';
  if (state.verification?.status !== 'verified' || !state.upload) {
    return 'This category has no verified archive. Run archive until all four checks pass.';
  }
  if (state.deletion?.finishedAt) return 'This category was already deleted.';
  return null;
}

export async function recheck(options: RecheckOptions): Promise<Recheck> {
  const { state } = options;
  const upload = state.upload;
  const remote = state.verification?.remote;
  if (!upload || !remote) return { problems: ['There is no verified upload to check against'] };

  const transcripts = await readTranscripts(options.treeDir, state);
  const capture = await checkCapture(options.discord, state, transcripts);
  const problems = [...capture.problems];

  // OneDrive: the run record still says verified, every file is unchanged, and nothing was added.
  // quickXorHash is OneDrive's own checksum, so nothing needs downloading again.
  const record = await readRunRecord(options.graph, upload.folderId).catch(() => null);
  if (record?.status !== 'verified') problems.push(`${RUN_RECORD} in OneDrive no longer says verified`);

  const { files } = await walk(options.graph, upload.folderId);
  const manifest = parseManifest(await readFile(join(options.treeDir, MANIFEST_NAME), 'utf8'));
  for (const [path, expected] of Object.entries(remote)) {
    const item = files.get(path);
    if (!item) {
      problems.push(`${path} is no longer in OneDrive`);
      continue;
    }
    const quickXorHash = item.file?.hashes?.quickXorHash ?? null;
    if (item.size !== expected.size) problems.push(`${path} changed size in OneDrive since it was verified`);
    else if (expected.quickXorHash && quickXorHash !== expected.quickXorHash) {
      problems.push(`${path} changed in OneDrive since it was verified`);
    } else if (!expected.quickXorHash || !quickXorHash) {
      // No OneDrive checksum to compare: read the file back instead.
      const back = await options.graph.downloadSha256(item.id);
      const sha256 = path === MANIFEST_NAME ? null : manifest.get(path);
      if (sha256 && back.sha256 !== sha256) problems.push(`${path} changed in OneDrive since it was verified`);
    }
  }
  for (const path of files.keys()) {
    if (path !== RUN_RECORD && !remote[path]) problems.push(`${path} was added to OneDrive after verification`);
  }
  return { problems };
}

export interface Planned {
  id: string;
  name: string;
  messages: number;
  threads: number;
}

// What delete will remove: every captured channel not yet deleted, in the order of the index.
export function plan(state: RunState): Planned[] {
  return Object.entries(state.channels)
    .filter(([id]) => !state.deletion?.deleted[id])
    .map(([id, record]) => ({ id, name: record.entry.name, messages: record.entry.messages, threads: record.entry.threads }));
}

export interface DeleteOptions {
  discord: Discord;
  state: RunState;
  reason: string;
  // Called before and after every channel, so state on disk always shows what is gone.
  save: () => Promise<void>;
  onDeleted: (channel: Planned, outcome: 'deleted' | 'gone') => Promise<void>;
  log: (line: string) => void;
}

export interface DeleteResult {
  deleted: Planned[];
  skipped: Array<{ channel: Planned; why: string }>;
}

// One channel at a time. A channel moved out of the category since the archive is left alone:
// moving it out is how someone keeps a channel (decision D7). Any error stops the run, and
// running delete again carries on from the next channel.
export async function deleteChannels(options: DeleteOptions): Promise<DeleteResult> {
  const { discord, state, log } = options;
  state.deletion ??= { startedAt: new Date().toISOString(), deleted: {} };
  const deletion = state.deletion;
  const now = new Map((await discord.guildChannels(state.guildId)).map((channel) => [channel.id, channel]));
  const result: DeleteResult = { deleted: [], skipped: [] };

  const planned = plan(state);
  for (const [index, channel] of planned.entries()) {
    const progress = `[${index + 1}/${planned.length}] #${channel.name}`;
    const live = now.get(channel.id);
    if (live && live.parent_id !== state.categoryId) {
      result.skipped.push({ channel, why: 'moved out of the category, so it was kept' });
      deletion.kept ??= {};
      deletion.kept[channel.id] = 'moved out of the category';
      log(`${progress}: moved out of the category, kept`);
      continue;
    }

    deletion.inProgress = channel.id;
    await options.save();
    const outcome = live ? await discord.deleteChannel(channel.id, options.reason) : 'gone';
    deletion.deleted[channel.id] = new Date().toISOString();
    delete deletion.inProgress;
    await options.save();
    await options.onDeleted(channel, outcome);
    result.deleted.push(channel);
    log(`${progress}: ${outcome === 'deleted' ? 'deleted' : 'was already gone'}`);
  }

  deletion.finishedAt = new Date().toISOString();
  await options.save();
  return result;
}
