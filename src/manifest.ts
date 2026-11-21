import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

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
    if (entries.has(path)) throw new Error(`Manifest lists ${path} twice`);
    entries.set(path, sha256);
  }
  return entries;
}
