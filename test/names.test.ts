import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { claimFileName, claimFolderName, safeName } from '../src/names.ts';

describe('safeName', () => {
  test('replaces every character OneDrive rejects', () => {
    assert.equal(safeName('a"b*c:d<e>f?g/h\\i|j'), 'a_b_c_d_e_f_g_h_i_j');
  });

  test('replaces control characters', () => {
    assert.equal(safeName('line\nbreak\ttab'), 'line_break_tab');
  });

  test('trims spaces and trailing dots', () => {
    assert.equal(safeName('  appeal...  '), 'appeal');
  });

  test('never starts with a tilde', () => {
    assert.equal(safeName('~draft'), '_draft');
  });

  test('renames reserved names, with or without an extension', () => {
    assert.equal(safeName('CON'), '_CON');
    assert.equal(safeName('nul.txt'), '_nul.txt');
    assert.equal(safeName('desktop.ini'), '_desktop.ini');
    assert.equal(safeName('.lock'), '_.lock');
    assert.equal(safeName('console'), 'console');
  });

  test('breaks up _vti_', () => {
    assert.equal(safeName('my_vti_folder'), 'my_vti-folder');
  });

  test('keeps accents and emoji', () => {
    assert.equal(safeName('café-account-check'), 'café-account-check');
    assert.equal(safeName('🎉 party'), '🎉 party');
  });

  test('cuts to 80 characters without splitting an emoji', () => {
    const name = safeName('🎉'.repeat(100));
    assert.equal(Array.from(name).length, 80);
    assert.ok(!name.includes('�'));
  });

  test('never returns an empty name', () => {
    assert.equal(safeName('...'), '_');
    assert.equal(safeName(''), '_');
  });
});

describe('claimFolderName', () => {
  test('adds the last 6 digits of the ID on a clash', () => {
    const taken = new Set<string>();
    assert.equal(claimFolderName('appeal', '900000000000851068', taken), 'appeal');
    assert.equal(claimFolderName('appeal', '1436131976791999999', taken), 'appeal (999999)');
  });

  test('treats names that differ only by case as a clash', () => {
    const taken = new Set<string>();
    claimFolderName('Appeal', '1', taken);
    assert.equal(claimFolderName('appeal', '900000000000851068', taken), 'appeal (851068)');
  });

  test('keeps the ID suffix when the name is at the length limit', () => {
    const taken = new Set<string>();
    const long = 'x'.repeat(120);
    claimFolderName(long, '1', taken);
    const second = claimFolderName(long, '900000000000851068', taken);
    assert.ok(second.endsWith(' (851068)'));
    assert.ok(Array.from(second).length <= 80);
  });

  test('throws rather than reusing a folder', () => {
    const taken = new Set<string>();
    claimFolderName('appeal', '100851068', taken);
    claimFolderName('appeal', '200851068', taken);
    assert.throws(() => claimFolderName('appeal', '300851068', taken), /both be named/);
  });
});

describe('claimFileName', () => {
  test('numbers repeats in the order they are claimed and keeps the extension', () => {
    const taken = new Map<string, number>();
    assert.equal(claimFileName('image.png', taken), 'image.png');
    assert.equal(claimFileName('image.png', taken), 'image (2).png');
    assert.equal(claimFileName('IMAGE.PNG', taken), 'IMAGE (3).PNG');
  });

  test('skips a number already used by a file really named that way', () => {
    const taken = new Map<string, number>();
    assert.equal(claimFileName('image (2).png', taken), 'image (2).png');
    assert.equal(claimFileName('image.png', taken), 'image.png');
    assert.equal(claimFileName('image.png', taken), 'image (3).png');
    assert.equal(claimFileName('image (2).png', taken), 'image (2) (2).png');
    assert.equal(claimFileName('image.png', taken), 'image (4).png');
  });

  test('stays quick when thousands of files share one name', () => {
    const taken = new Map<string, number>();
    const start = performance.now();
    let last = '';
    for (let index = 0; index < 20_000; index++) last = claimFileName('image.png', taken);
    assert.equal(last, 'image (20000).png');
    assert.equal(taken.size, 20_000);
    // Counting up from 2 for every file takes minutes here; remembering the number takes milliseconds.
    assert.ok(performance.now() - start < 5000, 'took too long');
  });

  test('cleans the name and keeps unusual extensions on a clash', () => {
    const taken = new Map<string, number>();
    assert.equal(claimFileName('what?.jpg', taken), 'what_.jpg');
    assert.equal(claimFileName('game.SaveReplay', taken), 'game.SaveReplay');
    assert.equal(claimFileName('game.SaveReplay', taken), 'game (2).SaveReplay');
  });

  test('keeps the extension when the stem is cut', () => {
    const taken = new Map<string, number>();
    const name = claimFileName(`${'a'.repeat(200)}.png`, taken);
    assert.ok(name.endsWith('.png'));
    assert.ok(name.length <= 80);
  });
});

describe('names from Discord can never leave the archive folder', () => {
  test('turns path tricks and broken extensions into plain, valid names', () => {
    const taken = new Map<string, number>();
    const names = ['../../secrets.txt', '..', '.', 'C:\\Windows\\evil.dll', 'trailing.', 'photo.png ', 'x.<script>', '.env'].map((raw) =>
      claimFileName(raw, taken),
    );
    for (const name of names) {
      assert.ok(!name.includes('/') && !name.includes('\\'), name);
      assert.ok(name !== '.' && name !== '..', name);
      assert.ok(!/[. ]$/.test(name), `"${name}" ends with a dot or space`);
    }
    assert.ok(names.includes('photo.png'), 'a real extension survives');
    assert.ok(names.includes('.env'), 'a name that is only an extension keeps its dot');
    assert.deepEqual([safeName('..'), safeName('../x')], ['_', '.._x']);
  });
});
