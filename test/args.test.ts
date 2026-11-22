import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCommand } from '../src/args.ts';

const ID = '100000000000000002';

describe('parseCommand', () => {
  test('reads each command and its options', () => {
    assert.deepEqual(parseCommand(['capture', ID]), { name: 'capture', categoryId: ID });
    assert.deepEqual(parseCommand(['archive', ID, '--to', 'google-drive']), { name: 'archive', categoryId: ID, destination: 'google-drive', keep: false });
    assert.deepEqual(parseCommand(['archive', ID, '--to', 'onedrive', '--keep']), { name: 'archive', categoryId: ID, destination: 'onedrive', keep: true });
    assert.deepEqual(parseCommand(['delete', ID, '--dry-run']), { name: 'delete', categoryId: ID, dryRun: true });
  });

  test('shows the usage for anything that is not a whole command', () => {
    for (const argv of [[], ['archive', ID], ['capture'], ['capture', ID, 'extra'], ['delete', ID, '--to', 'onedrive'], ['archive', ID, '--to', 'onedrive', '--dry-run'], ['capture', ID, '--keep'], ['remove', ID]]) {
      assert.equal(parseCommand(argv), null, argv.join(' '));
    }
  });

  test('names the problem with a bad ID, destination or option', () => {
    assert.throws(() => parseCommand(['delete', '#general']), /"#general" is not a Discord ID/);
    assert.throws(() => parseCommand(['archive', ID, '--to', 'dropbox']), /--to must be one of: onedrive, google-drive/);
    assert.throws(() => parseCommand(['delete', ID, '--force']), /Unknown option '--force'/);
  });
});
