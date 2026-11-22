import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isDiscordMedia } from '../src/discord.ts';

describe('isDiscordMedia', () => {
  test('allows only Discord’s own file servers, over https', () => {
    for (const url of [
      'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1',
      'https://media.discordapp.net/stickers/1.png',
      'https://images-ext-1.discordapp.net/external/x/https/example.com/a.png',
    ]) {
      assert.ok(isDiscordMedia(url), url);
    }
    for (const url of [
      'http://cdn.discordapp.com/a.png',
      'https://cdn.discordapp.com.evil.test/a.png',
      'https://evilcdn.discordapp.com/a.png',
      'https://evil.test/cdn.discordapp.com/a.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:8080/admin',
      'file:///etc/passwd',
      'not a url',
    ]) {
      assert.ok(!isDiscordMedia(url), url);
    }
  });
});
