import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { formatManifest, parseManifest, sha256File } from '../src/manifest.ts';

const hasSha256sum = spawnSync('sha256sum', ['--version']).error === undefined;

describe('manifest', () => {
  test('sorts by path and uses two spaces', () => {
    const text = formatManifest([
      { path: 'b/two.png', sha256: 'b'.repeat(64) },
      { path: 'a/one.png', sha256: 'a'.repeat(64) },
    ]);
    assert.equal(text, `${'a'.repeat(64)}  a/one.png\n${'b'.repeat(64)}  b/two.png\n`);
  });

  test('reads back what it writes, including spaces in paths', () => {
    const entries = [{ path: 'example appeal/attachments/image (2).png', sha256: 'c'.repeat(64) }];
    assert.deepEqual(parseManifest(formatManifest(entries)), new Map([[entries[0]!.path, entries[0]!.sha256]]));
  });

  test('rejects a malformed or duplicate line', () => {
    assert.throws(() => parseManifest('not a manifest\n'), /not "<sha256>  <path>"/);
    const line = `${'d'.repeat(64)}  x.txt\n`;
    assert.throws(() => parseManifest(line + line), /twice/);
  });

  test('passes sha256sum -c', { skip: !hasSha256sum && 'sha256sum not installed' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
    try {
      await mkdir(join(dir, 'chan', 'attachments'), { recursive: true });
      const paths = ['chan/chan.html', 'chan/attachments/image (2).png'];
      for (const path of paths) await writeFile(join(dir, path), `content of ${path}`);
      const entries = await Promise.all(paths.map(async (path) => ({ path, sha256: await sha256File(join(dir, path)) })));
      await writeFile(join(dir, '_manifest-sha256.txt'), formatManifest(entries));
      execFileSync('sha256sum', ['-c', '--quiet', '_manifest-sha256.txt'], { cwd: dir });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseManifest paths', () => {
  test('rejects any path that would leave the archive', () => {
    const sum = 'a'.repeat(64);
    for (const path of ['../outside.txt', '/etc/passwd', 'a/../../b', 'a//b', './a']) {
      assert.throws(() => parseManifest(`${sum}  ${path}\n`), /leaves the archive/, path);
    }
    assert.equal(parseManifest(`${sum}  case-one/attachments/a b.png\n`).size, 1);
  });
});
