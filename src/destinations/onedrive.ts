import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriveItem, Graph } from '../graph.ts';
import { MANIFEST_NAME, parseManifest, sha256File } from '../manifest.ts';
import { safeName } from '../names.ts';
import type { RunState } from '../state.ts';

const MAX_FILE_ATTEMPTS = 3;
export const RUN_RECORD = '_run.json';

export interface UploadOptions {
  graph: Graph;
  // Folder path in the OneDrive that holds every archive, e.g. "Team/Archives". Must already exist.
  root: string;
  treeDir: string;
  state: RunState;
  // Called after every uploaded file, so a crash loses at most the file in flight.
  save: () => Promise<void>;
  log: (line: string) => void;
}

export interface UploadResult {
  folderName: string;
  webUrl: string;
  uploaded: number;
  skipped: number;
}

// The run record identifies a folder as one this tool made, for this category (decision D4).
export interface RunRecord {
  tool: 'discord-archive-tool-cli';
  schema: 1;
  guildId: string;
  categoryId: string;
  categoryName: string;
  status: 'in progress' | 'uploaded' | 'verified';
  updatedAt: string;
}

export async function uploadToOneDrive(options: UploadOptions): Promise<UploadResult> {
  const { graph, state, treeDir, log } = options;

  const owner = await graph.owner();
  log(`Using the OneDrive of ${owner}.`);
  const root = await graph.itemByPath(options.root);
  if (!root?.folder) {
    throw new Error(
      `OneDrive folder "${options.root}" was not found in the OneDrive of ${owner}. ` +
        'Check you signed in with the account that owns it (a folder only shared with you will not work), or fix ONEDRIVE_ROOT.',
    );
  }

  const folderName = safeName(state.categoryName);
  const folder = await openArchiveFolder(graph, root, folderName, state);
  if (state.upload?.folderId !== folder.id) {
    state.upload = { destination: 'onedrive', folderId: folder.id, webUrl: folder.webUrl, files: {} };
  }
  const done = state.upload.files;

  const manifestText = await readFile(join(treeDir, MANIFEST_NAME), 'utf8');
  const checksums = parseManifest(manifestText);
  checksums.set(MANIFEST_NAME, await sha256File(join(treeDir, MANIFEST_NAME)));

  // The index and manifest go last, so an archive that has them is one whose files all arrived.
  const last = ['_index.html', MANIFEST_NAME];
  const order = [...[...checksums.keys()].filter((path) => !last.includes(path)).sort(), ...last.filter((path) => checksums.has(path))];

  const folders = new Map<string, string>([['', folder.id]]);
  let uploaded = 0;
  let skipped = 0;
  for (const [index, path] of order.entries()) {
    const sha256 = checksums.get(path);
    if (!sha256) continue;
    if (done[path] === sha256) {
      skipped++;
      continue;
    }
    const slash = path.lastIndexOf('/');
    const parentId = await ensureFolders(graph, folders, slash === -1 ? '' : path.slice(0, slash));
    const name = path.slice(slash + 1);
    const local = join(treeDir, path);
    await uploadWithRetries(graph, parentId, name, local, (await stat(local)).size);
    done[path] = sha256;
    await options.save();
    uploaded++;
    log(`[${index + 1}/${order.length}] ${path}`);
  }

  await writeRunRecord(graph, folder.id, state, 'uploaded');
  return { folderName, webUrl: folder.webUrl, uploaded, skipped };
}

// D4: create the folder, or resume one this tool made for this category. Anything else stops.
async function openArchiveFolder(graph: Graph, root: DriveItem, name: string, state: RunState): Promise<DriveItem> {
  const existing = await graph.child(root.id, name);
  if (!existing) {
    const created = await graph.createFolder(root.id, name);
    // First file in, so a crash can never leave a folder of ours without its run record.
    await writeRunRecord(graph, created.id, state, 'in progress');
    return created;
  }

  const where = `OneDrive already has a folder named "${name}"`;
  if (!existing.folder) throw new Error(`${where}, and it is a file. Rename or move it, then run again.`);
  const recordItem = await graph.child(existing.id, RUN_RECORD);
  if (!recordItem) {
    throw new Error(`${where} that this tool didn't create. It won't write into it. Rename or move it, then run again.`);
  }
  const record = parseRunRecord(await graph.readText(recordItem.id));
  if (!record || record.guildId !== state.guildId || record.categoryId !== state.categoryId) {
    throw new Error(`${where} for a different category. Rename the category in Discord (for example, add the year), then run again.`);
  }
  if (record.status === 'verified') {
    throw new Error(`${where}, and that archive is already verified. A finished archive is never changed.`);
  }
  return existing;
}

function parseRunRecord(text: string): RunRecord | null {
  try {
    const record = JSON.parse(text) as Partial<RunRecord>;
    return record.tool === 'discord-archive-tool-cli' ? (record as RunRecord) : null;
  } catch {
    return null;
  }
}

async function writeRunRecord(graph: Graph, folderId: string, state: RunState, status: RunRecord['status']): Promise<void> {
  const record: RunRecord = {
    tool: 'discord-archive-tool-cli',
    schema: 1,
    guildId: state.guildId,
    categoryId: state.categoryId,
    categoryName: state.categoryName,
    status,
    updatedAt: new Date().toISOString(),
  };
  await graph.uploadText(folderId, RUN_RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

async function ensureFolders(graph: Graph, known: Map<string, string>, dir: string): Promise<string> {
  const cached = known.get(dir);
  if (cached) return cached;
  const slash = dir.lastIndexOf('/');
  const parentId = await ensureFolders(graph, known, slash === -1 ? '' : dir.slice(0, slash));
  const name = dir.slice(slash + 1);
  // Only reached inside a folder this run owns, so an existing subfolder is one we made earlier.
  const folder = (await graph.child(parentId, name)) ?? (await graph.createFolder(parentId, name));
  known.set(dir, folder.id);
  return folder.id;
}

async function uploadWithRetries(graph: Graph, parentId: string, name: string, local: string, size: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const item = await graph.upload(parentId, name, local, size);
      if (item.size !== undefined && item.size !== size) {
        throw new Error(`OneDrive stored ${item.size} bytes for ${name}, expected ${size}`);
      }
      return;
    } catch (error) {
      if (attempt >= MAX_FILE_ATTEMPTS) throw error;
    }
  }
}
