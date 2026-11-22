import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RemoteItem, Store } from '../../src/destinations/store.ts';
import { RemoteError } from '../../src/http.ts';

interface Node {
  id: string;
  name: string;
  parentId: string | null;
  folder: boolean;
  content: Uint8Array | null;
}

// An in-memory destination for tests. Names are case-insensitive, as in OneDrive. The archive
// root is "Team/Archives", and like OneDrive's it must exist already.
export const ROOT = 'Team/Archives';

const checksum = (content: Uint8Array) => `sum-${createHash('sha1').update(content).digest('hex').slice(0, 8)}`;

export function fakeStore() {
  const nodes = new Map<string, Node>();
  const writes: string[] = [];
  let next = 0;
  const add = (parentId: string | null, name: string, folder: boolean, content: Uint8Array | null = null) => {
    const node = { id: `item-${next++}`, name, parentId, folder, content };
    nodes.set(node.id, node);
    return node;
  };
  const find = (parentId: string, name: string) =>
    [...nodes.values()].find((node) => node.parentId === parentId && node.name.toLowerCase() === name.toLowerCase());
  const pathOf = (node: Node): string => {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    return parent && parent.parentId ? `${pathOf(parent)}/${node.name}` : node.name;
  };
  const byPath = (path: string) => [...nodes.values()].find((node) => pathOf(node) === path);
  const view = (node: Node): RemoteItem => ({
    id: node.id,
    name: node.name,
    webUrl: `https://drive.test/${encodeURI(pathOf(node))}`,
    folder: node.folder,
    ...(node.folder ? {} : { size: node.content?.byteLength ?? 0 }),
    checksum: node.folder ? null : checksum(node.content ?? new Uint8Array()),
  });
  const write = (parentId: string, name: string, content: Uint8Array) => {
    const existing = find(parentId, name);
    if (existing) existing.content = content;
    const node = existing ?? add(parentId, name, false, content);
    writes.push(pathOf(node));
    return view(node);
  };

  const top = add(null, '', true);
  const store: Store = {
    label: 'Test Drive',
    account: async () => 'Archive Owner <owner@example.test>',
    root: async () => {
      const root = byPath(ROOT);
      if (!root) throw new Error(`Test Drive folder "${ROOT}" was not found`);
      return view(root);
    },
    item: async (id) => {
      const node = nodes.get(id);
      if (!node) throw new RemoteError(404, 'not found');
      return view(node);
    },
    child: async (parentId, name) => {
      const node = find(parentId, name);
      return node ? view(node) : null;
    },
    children: async (folderId) => [...nodes.values()].filter((node) => node.parentId === folderId).map(view),
    createFolder: async (parentId, name) => {
      if (find(parentId, name)) throw new RemoteError(409, 'exists');
      return view(add(parentId, name, true));
    },
    readText: async (id) => new TextDecoder().decode(nodes.get(id)?.content ?? new Uint8Array()),
    writeText: async (parentId, name, text) => write(parentId, name, new TextEncoder().encode(text)),
    upload: async (parentId, name, localPath) => write(parentId, name, new Uint8Array(await readFile(localPath))),
    download: async (id) => {
      const content = nodes.get(id)?.content ?? new Uint8Array();
      return { size: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
    },
  };

  const folder = (path: string) => {
    let parent = top;
    for (const part of path.split('/')) parent = find(parent.id, part) ?? add(parent.id, part, true);
    return parent;
  };
  return {
    store,
    writes,
    folder,
    add,
    checksum,
    text: (path: string) => {
      const content = byPath(path)?.content;
      return content ? new TextDecoder().decode(content) : null;
    },
    // Changes a stored file in place, as someone editing the archive by hand would.
    tamper: (path: string, content: string) => {
      const node = byPath(path);
      if (!node) throw new Error(`no ${path}`);
      node.content = new TextEncoder().encode(content);
    },
    remove: (path: string) => {
      const node = byPath(path);
      if (node) nodes.delete(node.id);
    },
  };
}

export type FakeStore = ReturnType<typeof fakeStore>;
