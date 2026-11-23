import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { audit } from '../src/audit.ts';
import { runReport, splitLines } from '../src/report.ts';

describe('runReport', () => {
  const summary = {
    categoryName: 'Archive *November* 2026',
    destination: 'OneDrive',
    webUrl: 'https://onedrive.test/archive',
    channels: [
      { name: 'case_one', messages: 211 },
      { name: 'appeals', messages: 1 },
    ],
    messages: 212,
    files: 9,
    operator: 'tester',
    at: new Date('2026-11-22T14:56:00.000Z'),
  };

  test('summarises the run in one post, with a link and a time each reader sees in their own zone', () => {
    const [post] = runReport({ ...summary, outcome: { status: 'deleted', deleted: ['case_one'], kept: ['appeals'] } });
    assert.equal(
      post,
      [
        '## 🗄️ Archive \\*November\\* 2026',
        '✅ Archived to OneDrive and verified · 4 of 4 checks passed',
        '🗑️ Deleted 1 channel · the category was kept',
        '📊 2 channels · 212 messages · 9 files',
        '📁 [Open the archive in OneDrive](<https://onedrive.test/archive>)',
        '',
        '**Channels**',
        '• #case\\_one · 211 messages',
        '• #appeals · 1 message · kept (moved out of the category)',
        '-# tester · <t:1795359360:f>',
      ].join('\n'),
    );
  });

  test('says plainly when nothing was deleted, and why', () => {
    const line = (status: 'kept' | 'stopped' | 'refused') => runReport({ ...summary, outcome: { status } })[0]?.split('\n')[2];
    assert.equal(line('kept'), '⏸️ Channels kept on purpose · nothing deleted');
    assert.equal(line('stopped'), '⏸️ Stopped before deleting · nothing deleted');
    assert.match(line('refused') ?? '', /^⚠️ Not deleted · Discord or OneDrive changed after verifying/);
  });

  test('names the destination that was used, not always OneDrive', () => {
    const post = runReport({ ...summary, destination: 'Google Drive', outcome: { status: 'refused' } })[0] ?? '';
    assert.match(post, /Not deleted · Discord or Google Drive changed after verifying/);
    assert.doesNotMatch(post, /OneDrive/);
  });
});

describe('splitLines', () => {
  test('keeps every message within the limit without splitting a line', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`);
    const messages = splitLines(lines, 20);
    assert.ok(messages.every((text) => text.length <= 20));
    assert.deepEqual(messages.join('\n').split('\n'), lines);
  });

  test('shortens a single line longer than the limit', () => {
    assert.deepEqual(splitLines(['x'.repeat(30)], 10), [`${'x'.repeat(9)}…`]);
  });
});

describe('audit', () => {
  test('appends one JSON line per event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'));
    try {
      const entry = {
        event: 'archive-verified' as const,
        operator: 'tester',
        guildId: '100000000000000001',
        categoryId: '100000000000000002',
        categoryName: 'Archive 2026',
        folder: 'Team/Archives/Archive 2026',
        webUrl: 'https://onedrive.test/archive',
        channels: 2,
        messages: 10,
        files: 1,
      };
      await audit(dir, entry, new Date('2026-11-22T10:00:00.000Z'));
      await audit(dir, { ...entry, event: 'archive-failed', failedChecks: ['Upload intact'] }, new Date('2026-11-22T11:00:00.000Z'));
      const lines = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((line) => [line.time, line.event]), [
        ['2026-11-22T10:00:00.000Z', 'archive-verified'],
        ['2026-11-22T11:00:00.000Z', 'archive-failed'],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
