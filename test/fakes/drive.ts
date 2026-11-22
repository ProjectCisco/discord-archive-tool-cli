import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GraphError, type DriveItem, type Graph } from '../../src/graph.ts';

interface Node {
  id: string;
  name: string;
  parentId: string | null;
  folder: boolean;
  content: Uint8Array | null;
}

// An in-memory OneDrive for tests. Names are case-insensitive, as in OneDrive.
export function fakeDrive() {
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
  const view = (node: Node): DriveItem => ({
    id: node.id,
    name: node.name,
    webUrl: `https://onedrive.test/${encodeURI(pathOf(node))}`,
    ...(node.folder
      ? { folder: {} }
      : { file: { hashes: { quickXorHash: `qx-${createHash('sha1').update(node.content ?? new Uint8Array()).digest('hex').slice(0, 8)}` } }, size: node.content?.byteLength ?? 0 }),
  });
  const store = (parentId: string, name: string, content: Uint8Array) => {
    const existing = find(parentId, name);
    if (existing) existing.content = content;
    const node = existing ?? add(parentId, name, false, content);
    writes.push(pathOf(node));
    return view(node);
  };

  const root = add(null, '', true);
  const graph: Graph = {
    owner: async () => 'Archive Owner <owner@example.test>',
    itemByPath: async (path) => {
      let node: Node | undefined = root;
      for (const part of path.split('/')) node = node ? find(node.id, part) : undefined;
      return node ? view(node) : null;
    },
    child: async (parentId, name) => {
      const node = find(parentId, name);
      return node ? view(node) : null;
    },
    createFolder: async (parentId, name) => {
      if (find(parentId, name)) throw new GraphError(409, 'nameAlreadyExists', 'exists');
      return view(add(parentId, name, true));
    },
    item: async (itemId) => {
      const node = nodes.get(itemId);
      if (!node) throw new GraphError(404, 'itemNotFound', 'not found');
      return view(node);
    },
    children: async (folderId) => [...nodes.values()].filter((node) => node.parentId === folderId).map(view),
    downloadSha256: async (itemId) => {
      const content = nodes.get(itemId)?.content ?? new Uint8Array();
      return { size: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
    },
    readText: async (itemId) => new TextDecoder().decode(nodes.get(itemId)?.content ?? new Uint8Array()),
    uploadText: async (parentId, name, text) => store(parentId, name, new TextEncoder().encode(text)),
    upload: async (parentId, name, localPath) => store(parentId, name, new Uint8Array(await readFile(localPath))),
  };

  const text = (path: string) => {
    const node = [...nodes.values()].find((candidate) => pathOf(candidate) === path);
    return node?.content ? new TextDecoder().decode(node.content) : null;
  };
  const folder = (path: string) => {
    const parts = path.split('/');
    let parent = root;
    for (const part of parts) parent = find(parent.id, part) ?? add(parent.id, part, true);
    return parent;
  };
  // Changes a stored file in place, as someone editing the archive by hand would.
  const tamper = (path: string, content: string) => {
    const node = [...nodes.values()].find((candidate) => pathOf(candidate) === path);
    if (!node) throw new Error(`no ${path}`);
    node.content = new TextEncoder().encode(content);
  };
  const remove = (path: string) => {
    const node = [...nodes.values()].find((candidate) => pathOf(candidate) === path);
    if (node) nodes.delete(node.id);
  };
  return { graph, writes, text, folder, add, tamper, remove };
}

export type FakeDrive = ReturnType<typeof fakeDrive>;
