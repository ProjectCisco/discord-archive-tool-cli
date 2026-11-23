import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { MANIFEST_PATH } from './layout.ts';
import { writeFileAtomic } from './state.ts';

export interface ManifestEntry {
  path: string;
  sha256: string;
}

const LINE = /^([0-9a-f]{64}) {2}(.+)$/;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Same format as `sha256sum`, so `sha256sum -c` can check an archive with no other tools.
export function formatManifest(entries: ManifestEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => `${entry.sha256}  ${entry.path}\n`)
    .join('');
}

export function parseManifest(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = LINE.exec(line);
    const sha256 = match?.[1];
    const path = match?.[2];
    if (!sha256 || !path) throw new Error(`Manifest line is not "<sha256>  <path>": ${line}`);
    // Paths are joined onto the archive folder, so none may climb out of it.
    if (path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      throw new Error(`Manifest path leaves the archive: ${path}`);
    }
    if (entries.has(path)) throw new Error(`Manifest lists ${path} twice`);
    entries.set(path, sha256);
  }
  return entries;
}

// Every file under `root` except the manifest itself, with forward-slash paths on every OS.
// Paths are relative to `root`, so `sha256sum -c _data/_manifest-sha256.txt` works from there.
export async function writeManifest(root: string): Promise<number> {
  const items = await readdir(root, { recursive: true, withFileTypes: true });
  const paths = items
    .filter((item) => item.isFile())
    .map((item) => relative(root, join(item.parentPath, item.name)).split(sep).join('/'))
    .filter((path) => path !== MANIFEST_PATH);

  const entries: ManifestEntry[] = [];
  for (const path of paths) entries.push({ path, sha256: await sha256File(join(root, path)) });
  await mkdir(dirname(join(root, MANIFEST_PATH)), { recursive: true });
  await writeFileAtomic(join(root, MANIFEST_PATH), formatManifest(entries));
  return entries.length;
}
