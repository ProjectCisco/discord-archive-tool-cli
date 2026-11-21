import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.ts';

const valid = {
  DISCORD_TOKEN: 'secret-token-value',
  DISCORD_LOG_CHANNEL_ID: '900000000000851068',
  GRAPH_TENANT_ID: '0b8e5f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  GRAPH_CLIENT_ID: '1c9f6a4b-2d3e-4f50-9b8c-1d2e3f4a5b6c',
  ONEDRIVE_ROOT: '/team/Archives/',
  ARCHIVER_DATA_DIR: '/opt/archiver/data',
};

describe('loadConfig', () => {
  test('reads and tidies valid values', () => {
    const config = loadConfig(valid);
    assert.equal(config.oneDriveRoot, 'team/Archives');
    assert.equal(config.logChannelId, '900000000000851068');
  });

  test('names every missing or malformed value at once', () => {
    assert.throws(
      () => loadConfig({ ...valid, DISCORD_TOKEN: ' ', GRAPH_CLIENT_ID: 'not-a-guid', DISCORD_LOG_CHANNEL_ID: '#logs' }),
      (error: Error) =>
        error.message.includes('DISCORD_TOKEN is missing') &&
        error.message.includes('GRAPH_CLIENT_ID is not in the expected format') &&
        error.message.includes('DISCORD_LOG_CHANNEL_ID is not in the expected format'),
    );
  });

  test('never puts a value in the error', () => {
    assert.throws(
      () => loadConfig({ ...valid, GRAPH_TENANT_ID: 'secret-token-value' }),
      (error: Error) => !error.message.includes('secret-token-value'),
    );
  });
});
