import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Destination } from './config.ts';
import type { RemoteItem, Store } from './destinations/store.ts';
import { withRetries } from './http.ts';
import { DATA_DIR, INDEX_NAME, MANIFEST_PATH, RUN_RECORD_NAME } from './layout.ts';
import { parseManifest, sha256File } from './manifest.ts';
import { safeName } from './names.ts';
import { mapParallel } from './parallel.ts';
import type { RunState } from './state.ts';

// The archive folder at a destination: which one may be used, what goes in it and in what order,
// and resuming. The same for every destination.

// Identifies a folder as one this tool made, for one category.
export interface RunRecord {
  tool: 'discord-archive-tool-cli';
  schema: 1;
  guildId: string;
  categoryId: string;
  categoryName: string;
  status: 'in progress' | 'uploaded' | 'verified';
  updatedAt: string;
  // Present once verification has run: each check's name and whether it passed.
  checks?: Array<{ name: string; passed: boolean }>;
}

export interface Owner {
  guildId: string;
  categoryId: string;
}

// Run before capture, so a wrong account, a missing root or a folder that can't be used stops the
// run in seconds. Writes nothing (except Google Drive's root folder, on the very first run).
export async function preflight(store: Store, categoryName: string, owner: Owner, log: (line: string) => void): Promise<void> {
  log(`Using the ${store.label} of ${await store.account()}.`);
  await existingFolder(store, await store.root(), safeName(categoryName), owner);
}

export interface UploadOptions {
  store: Store;
  destination: Destination;
  treeDir: string;
  state: RunState;
  // Called after every uploaded file, so a crash loses at most the files in flight.
  save: () => Promise<void>;
  log: (line: string) => void;
}

export async function uploadArchive(options: UploadOptions) {
  const { store, state, treeDir, log } = options;
  const folderName = safeName(state.categoryName);
  const folder = await openFolder(store, await store.root(), folderName, state);
  if (state.upload?.folderId !== folder.id) {
    state.upload = { destination: options.destination, folderId: folder.id, webUrl: folder.webUrl, files: {} };
  }
  const done = state.upload.files;

  const checksums = parseManifest(await readFile(join(treeDir, MANIFEST_PATH), 'utf8'));
  checksums.set(MANIFEST_PATH, await sha256File(join(treeDir, MANIFEST_PATH)));
  const pending = [...checksums.keys()].filter((path) => done[path] !== checksums.get(path)).sort();
  const folders = await ensureFolders(store, folder.id, pending);

  // Uploads finish in any order, so their saves queue up: one writes the state file at a time.
  let saved = Promise.resolve();
  let sent = checksums.size - pending.length;
  const send = async (path: string) => {
    const sha256 = checksums.get(path);
    const parentId = folders.get(parentOf(path));
    if (!sha256 || !parentId) throw new Error(`${path} has no checksum or no folder to go in`);
    const name = path.slice(path.lastIndexOf('/') + 1);
    const local = join(treeDir, path);
    const { size } = await stat(local);
    await withRetries(async () => {
      const item = await store.upload(parentId, name, local, size);
      if (item.size !== undefined && item.size !== size) {
        throw new Error(`${store.label} stored ${item.size} bytes for ${name}, expected ${size}`);
      }
    });
    done[path] = sha256;
    await (saved = saved.then(options.save));
    log(`[${++sent}/${checksums.size}] ${path}`);
  };

  // The index and manifest go last, one after the other, so an archive that has them is one whose
  // files all arrived.
  const last = [INDEX_NAME, MANIFEST_PATH];
  await mapParallel(pending.filter((path) => !last.includes(path)), send);
  for (const path of last.filter((path) => pending.includes(path))) await send(path);

  await writeRunRecord(store, folder.id, state, 'uploaded');
  return { folderName, webUrl: folder.webUrl, uploaded: pending.length, skipped: checksums.size - pending.length };
}

async function openFolder(store: Store, root: RemoteItem, name: string, state: RunState): Promise<RemoteItem> {
  const existing = await existingFolder(store, root, name, state);
  if (existing) return existing;
  const created = await store.createFolder(root.id, name);
  // First file in, so a crash can never leave a folder of ours without its run record.
  await writeRunRecord(store, created.id, state, 'in progress');
  return created;
}

// Null when there's no folder by that name yet. Throws for any folder this run must not use.
async function existingFolder(store: Store, root: RemoteItem, name: string, owner: Owner): Promise<RemoteItem | null> {
  const existing = await store.child(root.id, name);
  if (!existing) return null;

  const where = `${store.label} already has a folder named "${name}"`;
  if (!existing.folder) throw new Error(`${where}, and it is a file. Rename or move it, then run again.`);
  const record = await readRunRecord(store, existing.id);
  if (record === undefined) {
    throw new Error(`${where} that this tool didn't create. It won't write into it. Rename or move it, then run again.`);
  }
  if (!record || record.guildId !== owner.guildId || record.categoryId !== owner.categoryId) {
    throw new Error(`${where} for a different category. Rename the category in Discord (for example, add the year), then run again.`);
  }
  if (record.status === 'verified') {
    throw new Error(`${where}, and that archive is already verified. A finished archive is never changed.`);
  }
  return existing;
}

// Undefined when there is no run record; null when there is one but it isn't ours or can't be read.
export async function readRunRecord(store: Store, folderId: string): Promise<RunRecord | null | undefined> {
  const data = await store.child(folderId, DATA_DIR);
  const item = data && (await store.child(data.id, RUN_RECORD_NAME));
  if (!item) return undefined;
  try {
    const record = JSON.parse(await store.readText(item.id)) as Partial<RunRecord>;
    return record.tool === 'discord-archive-tool-cli' ? (record as RunRecord) : null;
  } catch {
    return null;
  }
}

export async function writeRunRecord(
  store: Store,
  folderId: string,
  state: RunState,
  status: RunRecord['status'],
  checks?: RunRecord['checks'],
): Promise<void> {
  const record: RunRecord = {
    tool: 'discord-archive-tool-cli',
    schema: 1,
    guildId: state.guildId,
    categoryId: state.categoryId,
    categoryName: state.categoryName,
    status,
    updatedAt: new Date().toISOString(),
    ...(checks ? { checks } : {}),
  };
  const data = (await store.child(folderId, DATA_DIR)) ?? (await store.createFolder(folderId, DATA_DIR));
  await store.writeText(data.id, RUN_RECORD_NAME, `${JSON.stringify(record, null, 2)}\n`);
}

// Everything under an archive folder, by path relative to it. Folders are listed a level at a
// time, several at once.
export async function walk(store: Store, folderId: string) {
  const files = new Map<string, RemoteItem>();
  const folders = new Map<string, RemoteItem>();
  let level = [{ id: folderId, prefix: '' }];
  while (level.length > 0) {
    const listed = await mapParallel(level, async ({ id, prefix }) => ({ prefix, items: await store.children(id) }));
    level = [];
    for (const { prefix, items } of listed) {
      for (const item of items) {
        const path = `${prefix}${item.name}`;
        if (item.folder) {
          folders.set(path, item);
          level.push({ id: item.id, prefix: `${path}/` });
        } else {
          files.set(path, item);
        }
      }
    }
  }
  return { files, folders };
}

// The folder part of a path: "a/b/c.png" → "a/b", "c.png" → "".
function parentOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), 0));
}

// Finds or makes every folder the files need and returns each one's ID by path. Parents are done
// before their children, so the files can then go up in any order.
async function ensureFolders(store: Store, folderId: string, paths: string[]): Promise<Map<string, string>> {
  const ids = new Map([['', folderId]]);
  const wanted = new Set<string>();
  for (const path of paths) {
    for (let dir = parentOf(path); dir !== ''; dir = parentOf(dir)) wanted.add(dir);
  }

  const depth = (dir: string) => dir.split('/').length;
  for (let level = 1; ; level++) {
    const dirs = [...wanted].filter((dir) => depth(dir) === level);
    if (dirs.length === 0) return ids;
    await mapParallel(dirs, async (dir) => {
      const parentId = ids.get(parentOf(dir));
      if (!parentId) throw new Error(`Folder ${dir} has no parent`);
      const name = dir.slice(dir.lastIndexOf('/') + 1);
      // Only reached inside a folder this run owns, so an existing subfolder is one we made earlier.
      const made = (await store.child(parentId, name)) ?? (await store.createFolder(parentId, name));
      ids.set(dir, made.id);
    });
  }
}
