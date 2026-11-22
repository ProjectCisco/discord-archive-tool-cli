import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Destination } from './config.ts';
import type { RemoteItem, Store } from './destinations/store.ts';
import { MANIFEST_NAME, parseManifest, sha256File } from './manifest.ts';
import { safeName } from './names.ts';
import type { RunState } from './state.ts';

// The archive folder at a destination: which one may be used (decision D4), what goes in it and in
// what order, and resuming. The same for every destination.

const MAX_FILE_ATTEMPTS = 3;
export const RUN_RECORD = '_run.json';

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
  // Called after every uploaded file, so a crash loses at most the file in flight.
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

  const checksums = parseManifest(await readFile(join(treeDir, MANIFEST_NAME), 'utf8'));
  checksums.set(MANIFEST_NAME, await sha256File(join(treeDir, MANIFEST_NAME)));
  // The index and manifest go last, so an archive that has them is one whose files all arrived.
  const last = ['_index.html', MANIFEST_NAME];
  const order = [...[...checksums.keys()].filter((path) => !last.includes(path)).sort(), ...last.filter((path) => checksums.has(path))];

  const folders = new Map<string, string>([['', folder.id]]);
  let uploaded = 0;
  for (const [index, path] of order.entries()) {
    const sha256 = checksums.get(path);
    if (!sha256 || done[path] === sha256) continue;
    const slash = path.lastIndexOf('/');
    const parentId = await ensureFolders(store, folders, slash === -1 ? '' : path.slice(0, slash));
    const local = join(treeDir, path);
    await uploadWithRetries(store, parentId, path.slice(slash + 1), local, (await stat(local)).size);
    done[path] = sha256;
    await options.save();
    uploaded++;
    log(`[${index + 1}/${order.length}] ${path}`);
  }

  await writeRunRecord(store, folder.id, state, 'uploaded');
  return { folderName, webUrl: folder.webUrl, uploaded, skipped: order.length - uploaded };
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
  const item = await store.child(folderId, RUN_RECORD);
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
  await store.writeText(folderId, RUN_RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

// Everything under an archive folder, by path relative to it.
export async function walk(store: Store, folderId: string) {
  const files = new Map<string, RemoteItem>();
  const folders = new Map<string, RemoteItem>();
  const visit = async (id: string, prefix: string) => {
    for (const item of await store.children(id)) {
      const path = `${prefix}${item.name}`;
      if (item.folder) {
        folders.set(path, item);
        await visit(item.id, `${path}/`);
      } else {
        files.set(path, item);
      }
    }
  };
  await visit(folderId, '');
  return { files, folders };
}

async function ensureFolders(store: Store, known: Map<string, string>, dir: string): Promise<string> {
  const cached = known.get(dir);
  if (cached) return cached;
  const slash = dir.lastIndexOf('/');
  const parentId = await ensureFolders(store, known, slash === -1 ? '' : dir.slice(0, slash));
  const name = dir.slice(slash + 1);
  // Only reached inside a folder this run owns, so an existing subfolder is one we made earlier.
  const folder = (await store.child(parentId, name)) ?? (await store.createFolder(parentId, name));
  known.set(dir, folder.id);
  return folder.id;
}

// A file that fails is started again from zero, so a half-sent file is never kept.
async function uploadWithRetries(store: Store, parentId: string, name: string, local: string, size: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const item = await store.upload(parentId, name, local, size);
      if (item.size !== undefined && item.size !== size) {
        throw new Error(`${store.label} stored ${item.size} bytes for ${name}, expected ${size}`);
      }
      return;
    } catch (error) {
      if (attempt >= MAX_FILE_ATTEMPTS) throw error;
    }
  }
}
