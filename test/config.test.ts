import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isSnowflake, loadConfig } from '../src/config.ts';

const core = {
  DISCORD_TOKEN: 'secret-token-value',
  DISCORD_LOG_CHANNEL_ID: '100000000000000042',
  ARCHIVER_DATA_DIR: '/var/lib/archiver',
};

const oneDrive = {
  GRAPH_TENANT_ID: '0b8e5f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  GRAPH_CLIENT_ID: '1c9f6a4b-2d3e-4f50-9b8c-1d2e3f4a5b6c',
  ONEDRIVE_ROOT: '/Team/Archives/',
};

describe('loadConfig', () => {
  test('needs only the core settings when nothing is uploaded', () => {
    const config = loadConfig(core, null);
    assert.equal(config.logChannelId, '100000000000000042');
    assert.equal(config.oneDrive, null);
  });

  test('reads and tidies the OneDrive settings when OneDrive is the destination', () => {
    const config = loadConfig({ ...core, ...oneDrive }, 'onedrive');
    assert.equal(config.oneDrive?.root, 'Team/Archives');
  });

  test('requires the OneDrive settings only for OneDrive', () => {
    assert.throws(() => loadConfig(core, 'onedrive'), /GRAPH_TENANT_ID is missing/);
  });

  test('names every missing or malformed value at once', () => {
    assert.throws(
      () =>
        loadConfig(
          { ...core, ...oneDrive, DISCORD_TOKEN: ' ', GRAPH_CLIENT_ID: 'not-a-guid', DISCORD_LOG_CHANNEL_ID: '#logs' },
          'onedrive',
        ),
      (error: Error) =>
        error.message.includes('DISCORD_TOKEN is missing') &&
        error.message.includes('GRAPH_CLIENT_ID is not in the expected format') &&
        error.message.includes('DISCORD_LOG_CHANNEL_ID is not in the expected format'),
    );
  });

  test('never puts a value in the error', () => {
    assert.throws(
      () => loadConfig({ ...core, ...oneDrive, GRAPH_TENANT_ID: 'secret-token-value' }, 'onedrive'),
      (error: Error) => !error.message.includes('secret-token-value'),
    );
  });
});

describe('isSnowflake', () => {
  test('accepts Discord IDs and rejects anything else', () => {
    assert.ok(isSnowflake('100000000000000042'));
    assert.ok(!isSnowflake('42'));
    assert.ok(!isSnowflake('1000000000000000a2'));
  });
});
