import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { preflight, uploadArchive, type RunRecord } from '../src/archive-folder.ts';
import { MANIFEST_PATH, RUN_RECORD_PATH } from '../src/layout.ts';
import { writeManifest } from '../src/manifest.ts';
import { STATE_SCHEMA, type RunState } from '../src/state.ts';
import { fakeStore, type FakeStore } from './fakes/store.ts';

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
  await mkdir(join(treeDir, '_data'));
  await writeFile(join(treeDir, '_index.html'), 'index');
  await writeFile(join(treeDir, 'case-one', 'case-one.html'), 'page');
  await writeFile(join(treeDir, '_data', 'case-one.json'), '{}');
  await writeFile(join(treeDir, 'case-one', 'attachments', 'image.png'), 'png');
  await writeManifest(treeDir);
});
afterEach(async () => {
  await rm(treeDir, { recursive: true, force: true });
});

// More files for case-one, so several are waiting to go up at once.
async function addFiles(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await writeFile(join(treeDir, 'case-one', 'attachments', `file-${index}.png`), `png ${index}`);
  }
  await writeManifest(treeDir);
}

async function upload(drive: FakeStore, run = state(), saves: number[] = [], logs: string[] = []) {
  return uploadArchive({
    store: drive.store,
    destination: 'onedrive',
    treeDir,
    state: run,
    save: async () => {
      saves.push(Object.keys(run.upload?.files ?? {}).length);
    },
    log: (line) => logs.push(line),
  });
}

const record = (drive: FakeStore) =>
  JSON.parse(drive.text(`Team/Archives/Archive_ November 2026/${RUN_RECORD_PATH}`) ?? 'null') as RunRecord | null;

describe('uploadArchive', () => {
  test('creates the folder, writes the run record first and the index and manifest last', async () => {
    const drive = fakeStore();
    drive.folder('Team/Archives');
    const result = await upload(drive);

    const base = 'Team/Archives/Archive_ November 2026';
    assert.equal(result.folderName, 'Archive_ November 2026');
    assert.equal(result.uploaded, 5);
    // The channel files go up several at a time, in any order, between the fixed first and last ones.
    assert.equal(drive.writes[0], `${base}/${RUN_RECORD_PATH}`);
    assert.deepEqual(drive.writes.slice(1, 4).sort(), [
      `${base}/_data/case-one.json`,
      `${base}/case-one/attachments/image.png`,
      `${base}/case-one/case-one.html`,
    ]);
    assert.deepEqual(drive.writes.slice(4), [`${base}/_index.html`, `${base}/${MANIFEST_PATH}`, `${base}/${RUN_RECORD_PATH}`]);
    assert.equal(drive.text(`${base}/case-one/attachments/image.png`), 'png');
    assert.deepEqual(
      { ...record(drive), updatedAt: 'x' },
      { tool: 'discord-archive-tool-cli', schema: 1, guildId: GUILD, categoryId: CATEGORY, categoryName: 'Archive: November 2026', status: 'uploaded', updatedAt: 'x' },
    );
  });

  test('saves progress after every file and resumes without sending finished files again', async () => {
    const drive = fakeStore();
    drive.folder('Team/Archives');
    const run = state();
    const saves: number[] = [];
    const logs: string[] = [];
    await upload(drive, run, saves, logs);
    // One save per file, each made after its own file was recorded.
    assert.equal(saves.length, 5);
    assert.ok(saves.every((recorded, index) => recorded >= index + 1), saves.join(','));
    assert.equal(saves.at(-1), 5);
    assert.deepEqual(logs.map((line) => line.split(' ')[0]), ['[1/5]', '[2/5]', '[3/5]', '[4/5]', '[5/5]']);

    await writeFile(join(treeDir, 'case-one', 'case-one.html'), 'page, re-rendered');
    await writeManifest(treeDir);
    drive.writes.length = 0;
    logs.length = 0;
    const again = await upload(drive, run, [], logs);
    assert.equal(again.skipped, 3);
    assert.deepEqual(logs, ['[4/5] case-one/case-one.html', `[5/5] ${MANIFEST_PATH}`]);
    assert.deepEqual(drive.writes, [
      'Team/Archives/Archive_ November 2026/case-one/case-one.html',
      `Team/Archives/Archive_ November 2026/${MANIFEST_PATH}`,
      `Team/Archives/Archive_ November 2026/${RUN_RECORD_PATH}`,
    ]);
  });

  test('sends several files at once, but writes the run state one save at a time', async () => {
    await addFiles(12);
    const drive = fakeStore();
    drive.folder('Team/Archives');
    // Long enough that the four uploads are sure to overlap, whatever else the machine is doing.
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const busy = { uploads: 0, mostUploads: 0, saves: 0, mostSaves: 0 };
    const real = drive.store.upload;
    drive.store.upload = async (...args) => {
      busy.mostUploads = Math.max(busy.mostUploads, ++busy.uploads);
      await pause(25);
      busy.uploads--;
      return real(...args);
    };

    const run = state();
    await uploadArchive({
      store: drive.store,
      destination: 'onedrive',
      treeDir,
      state: run,
      save: async () => {
        busy.mostSaves = Math.max(busy.mostSaves, ++busy.saves);
        await pause(2);
        busy.saves--;
      },
      log: () => {},
    });
    assert.equal(busy.mostUploads, 4);
    assert.equal(busy.mostSaves, 1);
    assert.equal(Object.keys(run.upload?.files ?? {}).length, 17);
  });

  test('makes each folder once, before any file goes into it', async () => {
    await mkdir(join(treeDir, 'case-two', 'attachments'), { recursive: true });
    for (const name of ['a.png', 'b.png', 'c.png']) await writeFile(join(treeDir, 'case-two', 'attachments', name), name);
    await writeManifest(treeDir);
    const drive = fakeStore();
    drive.folder('Team/Archives');
    const events: string[] = [];
    const { createFolder, upload: send } = drive.store;
    drive.store.createFolder = async (parentId, name) => {
      events.push(`folder ${name}`);
      return createFolder(parentId, name);
    };
    drive.store.upload = async (parentId, name, ...rest) => {
      events.push(`file ${name}`);
      return send(parentId, name, ...rest);
    };
    await upload(drive);

    const folders = events.filter((event) => event.startsWith('folder')).sort();
    assert.deepEqual(folders, [
      'folder Archive_ November 2026',
      'folder _data',
      'folder attachments',
      'folder attachments',
      'folder case-one',
      'folder case-two',
    ]);
    const lastFolder = events.findLastIndex((event) => event.startsWith('folder'));
    assert.ok(lastFolder < events.findIndex((event) => event.startsWith('file')));
    assert.equal(drive.text('Team/Archives/Archive_ November 2026/case-two/attachments/b.png'), 'b.png');
  });

  test('sends everything again if the folder was replaced since the last run', async () => {
    const drive = fakeStore();
    drive.folder('Team/Archives');
    const run = state();
    await upload(drive, run);
    run.upload = { destination: 'onedrive', folderId: 'a-folder-that-is-gone', webUrl: '', files: { ...run.upload?.files } };
    const again = await upload(drive, run);
    assert.equal(again.uploaded, 5);
  });

  test('never writes into a folder it did not create', async () => {
    const drive = fakeStore();
    drive.folder('Team/Archives/Archive_ November 2026');
    await assert.rejects(upload(drive), /that this tool didn't create/);
    assert.deepEqual(drive.writes, []);
  });

  test('never merges two categories that share a name', async () => {
    const drive = fakeStore();
    drive.folder('Team/Archives');
    await upload(drive);
    drive.writes.length = 0;
    await assert.rejects(upload(drive, { ...state(), categoryId: '100000000000000099' }), /for a different category/);
    assert.deepEqual(drive.writes, []);
  });

  test('never changes an archive that is already verified', async () => {
    const drive = fakeStore();
    const data = drive.folder('Team/Archives/Archive_ November 2026/_data');
    const verified: RunRecord = {
      tool: 'discord-archive-tool-cli',
      schema: 1,
      guildId: GUILD,
      categoryId: CATEGORY,
      categoryName: 'Archive: November 2026',
      status: 'verified',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    drive.add(data.id, '_run.json', false, new TextEncoder().encode(JSON.stringify(verified)));
    await assert.rejects(upload(drive), /already verified/);
    assert.deepEqual(drive.writes, []);
  });

  test('treats an unreadable run record as someone else’s folder', async () => {
    const drive = fakeStore();
    const data = drive.folder('Team/Archives/Archive_ November 2026/_data');
    drive.add(data.id, '_run.json', false, new TextEncoder().encode('not json'));
    await assert.rejects(upload(drive), /for a different category/);
  });

  test('retries a failed file, then stops if it keeps failing', async () => {
    const drive = fakeStore();
    drive.folder('Team/Archives');
    const real = drive.store.upload;
    let failures = 2;
    drive.store.upload = async (...args) => {
      if (failures-- > 0) throw new Error('connection reset');
      return real(...args);
    };
    assert.equal((await upload(drive)).uploaded, 5);

    drive.store.upload = async () => {
      throw new Error('connection reset');
    };
    await writeFile(join(treeDir, '_index.html'), 'changed');
    await writeManifest(treeDir);
    await assert.rejects(upload(drive), /connection reset/);
  });

  test('stops when the destination stored a different number of bytes than were sent', async () => {
    const drive = fakeStore();
    drive.folder('Team/Archives');
    const real = drive.store.upload;
    let tries = 0;
    drive.store.upload = async (parentId, name, ...rest) => {
      const item = await real(parentId, name, ...rest);
      if (name !== 'image.png') return item;
      tries++;
      return { ...item, size: 1 };
    };
    await assert.rejects(upload(drive), /Test Drive stored 1 bytes for image\.png, expected 3/);
    assert.equal(tries, 3);
  });

  test('when a file keeps failing, records the ones that arrived and never sends the index or manifest', async () => {
    await addFiles(12);
    const drive = fakeStore();
    drive.folder('Team/Archives');
    const real = drive.store.upload;
    drive.store.upload = async (parentId, name, ...rest) => {
      if (name === 'file-3.png') throw new Error('connection reset');
      return real(parentId, name, ...rest);
    };

    const run = state();
    await assert.rejects(upload(drive, run), /connection reset/);
    const recorded = Object.keys(run.upload?.files ?? {});
    const arrived = drive.writes
      .map((path) => path.replace('Team/Archives/Archive_ November 2026/', ''))
      .filter((path) => path !== RUN_RECORD_PATH);
    assert.deepEqual(recorded.sort(), arrived.sort(), 'the record matches what is in the folder');
    assert.ok(recorded.length > 0 && !recorded.includes('case-one/attachments/file-3.png'));
    assert.ok(!recorded.includes('_index.html') && !recorded.includes(MANIFEST_PATH));

    // Running again sends only what is missing.
    drive.store.upload = real;
    drive.writes.length = 0;
    const again = await upload(drive, run);
    assert.equal(again.skipped, recorded.length);
    assert.equal(again.uploaded + again.skipped, 17);
  });
});

describe('preflight', () => {
  const owner = { guildId: GUILD, categoryId: CATEGORY };
  const run = (drive: FakeStore, categoryId = CATEGORY) =>
    preflight(drive.store, 'Archive: November 2026', { ...owner, categoryId }, () => {});

  test('passes for a new archive or one of ours still in progress, and writes nothing', async () => {
    const drive = fakeStore();
    drive.folder('Team/Archives');
    await run(drive);
    assert.deepEqual(drive.writes, []);

    await upload(drive);
    drive.writes.length = 0;
    await run(drive);
    assert.deepEqual(drive.writes, []);
  });

  test('stops before capture for a folder that is not ours, or for another category', async () => {
    const foreign = fakeStore();
    foreign.folder('Team/Archives/Archive_ November 2026');
    await assert.rejects(run(foreign), /that this tool didn't create/);

    const other = fakeStore();
    other.folder('Team/Archives');
    await upload(other);
    await assert.rejects(run(other, '100000000000000099'), /for a different category/);
  });
});
