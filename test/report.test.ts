import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { audit } from '../src/audit.ts';
import { archiveReport, splitLines } from '../src/report.ts';

describe('archiveReport', () => {
  test('summarises the archive and shows formatting characters in names as text', () => {
    const [post] = archiveReport({
      categoryName: 'Archive *November* 2026',
      destination: 'OneDrive',
      webUrl: 'https://onedrive.test/archive',
      channels: ['case_one', 'appeals'],
      messages: 212,
      files: 9,
    });
    assert.equal(
      post,
      [
        '✅ Archived **Archive \\*November\\* 2026** to OneDrive and verified (4/4 checks passed).',
        '2 channels · 212 messages · 9 files',
        '<https://onedrive.test/archive>',
        'Nothing has been deleted yet.',
        '',
        'Channels:',
        '• #case\\_one',
        '• #appeals',
      ].join('\n'),
    );
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
