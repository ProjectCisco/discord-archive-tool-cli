import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexEntry } from './render.ts';
import type { Check, RemoteFile } from './verify.ts';

export interface CapturedChannel {
  folder: string;
  entry: IndexEntry;
  // Files saved as the original upload where Discord records a converted copy.
  converted: number;
  misses: string[];
}

export const STATE_SCHEMA = 2;

export interface RunState {
  schema: typeof STATE_SCHEMA;
  guildId: string;
  categoryId: string;
  categoryName: string;
  startedAt: string;
  // Keyed by channel ID. A channel appears here only once it is fully on disk.
  channels: Record<string, CapturedChannel>;
  upload?: {
    destination: 'onedrive';
    folderId: string;
    webUrl: string;
    // Path in the archive → SHA-256 of the copy that was uploaded. A changed file is sent again.
    files: Record<string, string>;
  };
  deletion?: {
    startedAt: string;
    // Channel ID → when it was deleted (or found already gone).
    deleted: Record<string, string>;
    // Channel ID → why it was left in place.
    kept?: Record<string, string>;
    // Set just before a delete call, cleared after: shows which channel a crash interrupted.
    inProgress?: string;
    finishedAt?: string;
  };
  // The last verification. Only 'verified' lets delete run.
  verification?: {
    status: 'verified' | 'failed';
    at: string;
    checks: Check[];
    remote: Record<string, RemoteFile>;
  };
}

// Write, flush, then rename: a crash leaves either the old file or the new one, never half of either.
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, 'w');
  try {
    await file.writeFile(data, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

export async function readState(runDir: string): Promise<RunState | null> {
  let text: string;
  try {
    text = await readFile(join(runDir, 'state.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // Resuming a run from another version would mix two folder layouts in one archive.
  const state = JSON.parse(text) as { schema?: unknown };
  if (state.schema !== STATE_SCHEMA) {
    throw new Error(`${runDir} was made by a different version of this tool. Delete that folder and run again.`);
  }
  return state as RunState;
}

export async function writeState(runDir: string, state: RunState): Promise<void> {
  await writeFileAtomic(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
}

export async function acquireLock(runDir: string): Promise<() => Promise<void>> {
  const path = join(runDir, 'lock');
  try {
    const file = await open(path, 'wx');
    await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const holder = await readFile(path, 'utf8').catch(() => 'unknown');
    throw new Error(
      `Another run is using ${runDir} (${holder}). If no run is active, delete ${path} and try again.`,
    );
  }
  return () => rm(path, { force: true });
}
