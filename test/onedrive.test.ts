import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { RUN_RECORD, uploadToOneDrive, type RunRecord } from '../src/destinations/onedrive.ts';
import { GraphError, type DriveItem, type Graph } from '../src/graph.ts';
import { MANIFEST_NAME, writeManifest } from '../src/manifest.ts';
import { STATE_SCHEMA, type RunState } from '../src/state.ts';

interface Node {
  id: string;
  name: string;
  parentId: string | null;
  folder: boolean;
  content: Uint8Array | null;
}

// An in-memory OneDrive. Names are case-insensitive, as in OneDrive.
function fakeDrive() {
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
    ...(node.folder ? { folder: {} } : { file: {}, size: node.content?.byteLength ?? 0 }),
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
  return { graph, writes, text, folder, add };
}

const GUILD = '100000000000000001';
const CATEGORY = '100000000000000002';

function state(): RunState {
  return {
    schema: STATE_SCHEMA,
    guildId: GUILD,
    categoryId: CATEGORY,
    categoryName: 'Archive: November 2026',
    startedAt: '2026-11-22T10:00:00.000Z',
    channels: {},
  };
}

let treeDir: string;
beforeEach(async () => {
  treeDir = await mkdtemp(join(tmpdir(), 'tree-'));
  await mkdir(join(treeDir, 'case-one', 'attachments'), { recursive: true });
  await writeFile(join(treeDir, '_index.html'), 'index');
  await writeFile(join(treeDir, 'case-one', 'case-one.html'), 'page');
  await writeFile(join(treeDir, 'case-one', 'case-one.json'), '{}');
  await writeFile(join(treeDir, 'case-one', 'attachments', 'image.png'), 'png');
  await writeManifest(treeDir);
});
afterEach(async () => {
  await rm(treeDir, { recursive: true, force: true });
});

async function upload(drive: ReturnType<typeof fakeDrive>, run = state(), saves: number[] = []) {
  return uploadToOneDrive({
    graph: drive.graph,
    root: 'Team/Archives',
    treeDir,
    state: run,
    save: async () => {
      saves.push(Object.keys(run.upload?.files ?? {}).length);
    },
    log: () => {},
  });
}

const record = (drive: ReturnType<typeof fakeDrive>) =>
  JSON.parse(drive.text(`Team/Archives/Archive_ November 2026/${RUN_RECORD}`) ?? 'null') as RunRecord | null;

describe('uploadToOneDrive', () => {
  test('creates the folder, writes the run record first and the index and manifest last', async () => {
    const drive = fakeDrive();
    drive.folder('Team/Archives');
    const result = await upload(drive);

    const base = 'Team/Archives/Archive_ November 2026';
    assert.equal(result.folderName, 'Archive_ November 2026');
    assert.equal(result.uploaded, 5);
    assert.deepEqual(drive.writes, [
      `${base}/${RUN_RECORD}`,
      `${base}/case-one/attachments/image.png`,
      `${base}/case-one/case-one.html`,
      `${base}/case-one/case-one.json`,
      `${base}/_index.html`,
      `${base}/${MANIFEST_NAME}`,
      `${base}/${RUN_RECORD}`,
    ]);
    assert.equal(drive.text(`${base}/case-one/attachments/image.png`), 'png');
    assert.deepEqual(
      { ...record(drive), updatedAt: 'x' },
      { tool: 'discord-archive-tool-cli', schema: 1, guildId: GUILD, categoryId: CATEGORY, categoryName: 'Archive: November 2026', status: 'uploaded', updatedAt: 'x' },
    );
  });

  test('saves progress after every file and resumes without sending finished files again', async () => {
    const drive = fakeDrive();
    drive.folder('Team/Archives');
    const run = state();
    const saves: number[] = [];
    await upload(drive, run, saves);
    assert.deepEqual(saves, [1, 2, 3, 4, 5]);

    await writeFile(join(treeDir, 'case-one', 'case-one.html'), 'page, re-rendered');
    await writeManifest(treeDir);
    drive.writes.length = 0;
    const again = await upload(drive, run);
    assert.equal(again.skipped, 3);
    assert.deepEqual(drive.writes, [
      'Team/Archives/Archive_ November 2026/case-one/case-one.html',
      `Team/Archives/Archive_ November 2026/${MANIFEST_NAME}`,
      `Team/Archives/Archive_ November 2026/${RUN_RECORD}`,
    ]);
  });

  test('sends everything again if the folder was replaced since the last run', async () => {
    const drive = fakeDrive();
    drive.folder('Team/Archives');
    const run = state();
    await upload(drive, run);
    run.upload = { destination: 'onedrive', folderId: 'a-folder-that-is-gone', webUrl: '', files: { ...run.upload?.files } };
    const again = await upload(drive, run);
    assert.equal(again.uploaded, 5);
  });

  test('stops if the archive root does not exist, rather than creating a mistyped path', async () => {
    await assert.rejects(
      upload(fakeDrive()),
      /OneDrive folder "Team\/Archives" was not found in the OneDrive of Archive Owner <owner@example.test>/,
    );
  });

  test('never writes into a folder it did not create', async () => {
    const drive = fakeDrive();
    drive.folder('Team/Archives/Archive_ November 2026');
    await assert.rejects(upload(drive), /that this tool didn't create/);
    assert.deepEqual(drive.writes, []);
  });

  test('never merges two categories that share a name', async () => {
    const drive = fakeDrive();
    drive.folder('Team/Archives');
    await upload(drive);
    drive.writes.length = 0;
    await assert.rejects(upload(drive, { ...state(), categoryId: '100000000000000099' }), /for a different category/);
    assert.deepEqual(drive.writes, []);
  });

  test('never changes an archive that is already verified', async () => {
    const drive = fakeDrive();
    const folder = drive.folder('Team/Archives/Archive_ November 2026');
    const verified: RunRecord = {
      tool: 'discord-archive-tool-cli',
      schema: 1,
      guildId: GUILD,
      categoryId: CATEGORY,
      categoryName: 'Archive: November 2026',
      status: 'verified',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    drive.add(folder.id, RUN_RECORD, false, new TextEncoder().encode(JSON.stringify(verified)));
    await assert.rejects(upload(drive), /already verified/);
    assert.deepEqual(drive.writes, []);
  });

  test('treats an unreadable run record as someone else’s folder', async () => {
    const drive = fakeDrive();
    const folder = drive.folder('Team/Archives/Archive_ November 2026');
    drive.add(folder.id, RUN_RECORD, false, new TextEncoder().encode('not json'));
    await assert.rejects(upload(drive), /for a different category/);
  });

  test('retries a failed file, then stops if it keeps failing', async () => {
    const drive = fakeDrive();
    drive.folder('Team/Archives');
    const real = drive.graph.upload;
    let failures = 2;
    drive.graph.upload = async (...args) => {
      if (failures-- > 0) throw new Error('connection reset');
      return real(...args);
    };
    assert.equal((await upload(drive)).uploaded, 5);

    drive.graph.upload = async () => {
      throw new Error('connection reset');
    };
    await writeFile(join(treeDir, '_index.html'), 'changed');
    await writeManifest(treeDir);
    await assert.rejects(upload(drive), /connection reset/);
  });
});
