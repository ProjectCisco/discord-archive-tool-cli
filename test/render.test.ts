import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MessageReferenceType, MessageType } from 'discord-api-types/v10';
import type { APIChannel, APIMessage } from 'discord-api-types/v10';
import { escapeHtml, renderCategoryIndex, renderTranscript } from '../src/render.ts';
import type { Transcript } from '../src/transcript.ts';

const HOSTILE = '<script>alert(1)</script>"\'><img src=x onerror=alert(2)>';

function user(id: string, username: string) {
  return { id, username, global_name: null, discriminator: '0', avatar: null };
}

function message(overrides: Partial<APIMessage> & { id: string }): APIMessage {
  return {
    channel_id: '100000000000000001',
    author: user('200000000000000001', 'alice'),
    content: '',
    timestamp: '2025-10-18T13:08:28.870000+00:00',
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: MessageType.Default,
    ...overrides,
  } as APIMessage;
}

function transcript(messages: APIMessage[], extra: Partial<Transcript> = {}): Transcript {
  return {
    schema: 1,
    archivedAt: '2026-11-21T20:00:00.000Z',
    guild: { id: '1', name: 'Example Server' },
    category: { id: '900000000000851068', name: 'Archive November 2026' },
    channel: { id: '100000000000000001', name: 'case-example', topic: null, raw: { id: '100000000000000001', type: 0 } as APIChannel },
    parent: null,
    messages,
    resolved: {
      users: { '200000000000000099': { id: '200000000000000099', username: 'bob', displayName: 'Bob' } },
      roles: { '300000000000000001': 'Moderators' },
      channels: { '400000000000000001': 'ticket-123' },
      forwardAuthors: {},
    },
    files: {},
    threads: {},
    ...extra,
  };
}

describe('escapeHtml', () => {
  test('escapes all five special characters', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('renderTranscript', () => {
  test('starts with a UTF-8 charset and blocks scripts', () => {
    const html = renderTranscript(transcript([]));
    assert.match(html, /^<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">/);
    assert.match(html, /script-src 'none'/);
  });

  test('escapes hostile content, names, embeds and file names', () => {
    const hostile = message({
      id: '500000000000000001',
      author: { ...user('200000000000000002', HOSTILE), global_name: HOSTILE },
      content: HOSTILE,
      embeds: [{ title: HOSTILE, description: HOSTILE, fields: [{ name: HOSTILE, value: HOSTILE }] }],
      attachments: [
        {
          id: '600000000000000001',
          filename: `${HOSTILE}.png`,
          size: 10,
          url: 'https://cdn.discordapp.com/x',
          proxy_url: 'https://media.discordapp.net/x',
          content_type: 'image/png',
        },
      ],
    });
    const html = renderTranscript(
      transcript([hostile], {
        files: {
          '600000000000000001': { path: `attachments/${HOSTILE}.png`, size: 10, sha256: 'a'.repeat(64), required: true },
        },
      }),
    );
    const body = html.slice(html.indexOf('<main>'));
    assert.ok(!body.includes('<script>'), 'no live script tag');
    assert.ok(!body.includes('<img src=x'), 'no injected img tag');
    const escaped = '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&gt;&lt;img src=x onerror=alert(2)&gt;';
    assert.ok(body.includes(`alt="${escaped}.png"`), 'file name stays inside its alt attribute');
    assert.ok(body.includes(`title="${escaped} · 200000000000000002"`), 'username stays inside its title attribute');
  });

  test('never links to Discord or any other cloud URL', () => {
    const withFile = message({
      id: '500000000000000002',
      attachments: [
        {
          id: '600000000000000002',
          filename: 'image.png',
          size: 29918,
          url: 'https://cdn.discordapp.com/attachments/1/2/image.png?ex=abc',
          proxy_url: 'https://media.discordapp.net/attachments/1/2/image.png',
          content_type: 'image/png',
        },
      ],
    });
    const html = renderTranscript(
      transcript([withFile], {
        files: { '600000000000000002': { path: 'attachments/image.png', size: 29918, sha256: 'b'.repeat(64), required: true } },
      }),
    );
    assert.ok(!/(src|href)="https?:/.test(html));
    assert.match(html, /<img src="attachments\/image\.png"/);
  });

  test('keeps [No text content] for attachment-only messages', () => {
    const html = renderTranscript(transcript([message({ id: '500000000000000003' })]));
    assert.match(html, /\[No text content\]/);
  });

  test('resolves user, role and channel mentions, keeping the IDs', () => {
    const html = renderTranscript(
      transcript([
        message({
          id: '500000000000000004',
          content: '<@200000000000000099> <@&300000000000000001> <#400000000000000001> <@999999999999999999>',
        }),
      ]),
    );
    assert.match(html, /title="200000000000000099">@Bob</);
    assert.match(html, /title="300000000000000001">@Moderators</);
    assert.match(html, /title="400000000000000001">#ticket-123</);
    assert.match(html, /title="999999999999999999">@unknown user</);
    assert.ok(!html.includes('&lt;@200000000000000099&gt;'));
  });

  test('writes custom emoji and Discord timestamps as text', () => {
    const html = renderTranscript(
      transcript([message({ id: '500000000000000005', content: '<:pog:123456789012345678> <t:1700000000:R>' })]),
    );
    assert.match(html, /:pog:/);
    assert.match(html, /2023-11-14 22:13:20 UTC/);
  });

  test('leaves an impossible Discord timestamp as text and escapes a bad message time', () => {
    const html = renderTranscript(
      transcript([message({ id: '500000000000000015', content: '<t:99999999999999999999>', timestamp: '<b>not a date</b>' })]),
    );
    assert.match(html, /&lt;t:99999999999999999999&gt;/);
    assert.match(html, /&lt;b&gt;not a date&lt;\/b&gt;/);
    assert.ok(!html.includes('<b>not a date'));
  });

  test('shows times in UTC with the zone written out', () => {
    const html = renderTranscript(transcript([message({ id: '500000000000000006', content: 'hi' })]));
    assert.match(html, /2025-10-18 13:08:28 UTC/);
  });

  test('shows a deleted reply parent instead of losing it silently', () => {
    const html = renderTranscript(
      transcript([message({ id: '500000000000000007', type: MessageType.Reply, referenced_message: null, content: 'ok' })]),
    );
    assert.match(html, /Replying to a message that was deleted/);
  });

  test('quotes and links a reply parent', () => {
    const parent = message({ id: '500000000000000008', content: 'original point' });
    const reply = message({ id: '500000000000000009', type: MessageType.Reply, referenced_message: parent, content: 'agreed' });
    const html = renderTranscript(transcript([parent, reply]));
    assert.match(html, /<a class="reply" href="#msg-500000000000000008">↪ alice: original point<\/a>/);
  });

  test('resolves mentions inside a reply preview', () => {
    const parent = message({ id: '500000000000000013', content: '<@200000000000000099> look at this' });
    const reply = message({ id: '500000000000000014', type: MessageType.Reply, referenced_message: parent, content: 'seen' });
    const html = renderTranscript(transcript([parent, reply]));
    const quote = html.slice(html.indexOf('class="reply"'));
    assert.match(quote, /@Bob<\/span> look at this/);
    assert.ok(!quote.includes('200000000000000099&gt;'));
  });

  test('renders a forward from its snapshot, saying where it came from', () => {
    const forward = message({
      id: '500000000000000010',
      message_reference: { type: MessageReferenceType.Forward, channel_id: '400000000000000001', message_id: '600000000000000099' },
      message_snapshots: [
        {
          message: {
            type: MessageType.Default,
            content: 'evidence text',
            embeds: [],
            attachments: [],
            timestamp: '2025-10-18T14:13:20.602000+00:00',
            edited_timestamp: null,
            flags: 0,
            mentions: [],
            mention_roles: [],
          },
        },
      ],
    });
    const html = renderTranscript(transcript([forward]));
    assert.match(html, /Forwarded from #ticket-123 · original author unknown/);
    assert.match(html, /evidence text/);
    assert.ok(!html.includes('[No text content]'));
  });

  test('shows edits, pins, reactions and thread links', () => {
    const html = renderTranscript(
      transcript(
        [
          message({
            id: '500000000000000011',
            content: 'decision',
            edited_timestamp: '2025-10-19T09:00:00.000000+00:00',
            pinned: true,
            reactions: [
              { count: 3, count_details: { burst: 0, normal: 3 }, me: false, me_burst: false, burst_colors: [], emoji: { id: null, name: '👍' } },
            ],
          }),
        ],
        { threads: { '500000000000000011': 'threads/follow up/transcript.html' } },
      ),
    );
    assert.match(html, /\(edited 2025-10-19 09:00:00 UTC\)/);
    assert.match(html, /📌 pinned/);
    assert.match(html, /👍 3/);
    assert.match(html, /href="threads\/follow%20up\/transcript\.html"/);
  });

  test('labels system messages', () => {
    const html = renderTranscript(
      transcript([message({ id: '500000000000000012', type: MessageType.ChannelPinnedMessage })]),
    );
    assert.match(html, /class="msg system"/);
    assert.match(html, /pinned a message/);
  });
});

describe('renderCategoryIndex', () => {
  test('lists channels with counts and escapes names', () => {
    const html = renderCategoryIndex({
      guildName: 'Example Server',
      categoryName: HOSTILE,
      categoryId: '900000000000851068',
      archivedAt: '2026-11-21T20:00:00.000Z',
      operator: 'operator',
      entries: [{ name: 'example-appeal', path: 'example-appeal/transcript.html', messages: 212, files: 9, threads: 1 }],
      misses: [],
    });
    assert.ok(!html.includes('<script>'));
    assert.match(html, /<a href="example-appeal\/transcript\.html">#example-appeal<\/a><\/td><td>212<\/td><td>9<\/td><td>1<\/td>/);
  });
});
