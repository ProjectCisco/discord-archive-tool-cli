import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createGoogleDrive } from '../src/destinations/google-drive.ts';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SESSION = 'https://upload.test/session-1';

interface Call {
  method: string;
  url: URL;
  authorization: string | null;
  contentRange: string | null;
  body: string;
}

function fakeGoogle(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : '';
    const call = { method: init?.method ?? 'GET', url: new URL(String(url)), authorization: headers.get('authorization'), contentRange: headers.get('content-range'), body };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  const drive = createGoogleDrive({
    token: async () => 'access-token',
    rootName: "Discord Archives",
    log: (line) => logs.push(line),
    fetch: http,
    sleep: async (ms) => {
      waits.push(ms);
    },
    chunkSize: 4,
  });
  return { drive, calls, waits, logs };
}

const file = (id: string, extra: object = {}) => ({ id, name: id, mimeType: 'text/plain', webViewLink: `https://drive.test/${id}`, ...extra });
const list = (...files: object[]) => Response.json({ files });
const folder = (id: string) => file(id, { mimeType: 'application/vnd.google-apps.folder' });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'google-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createGoogleDrive', () => {
  test('looks up a child by name, quoting it safely, and refuses to guess between duplicates', async () => {
    const { drive, calls } = fakeGoogle(() => list(file('a'), file('b')));
    await assert.rejects(drive.child('parent-1', "it's \\ here"), /2 items named "it's \\ here" in one folder/);
    assert.equal(calls[0]?.url.searchParams.get('q'), "'parent-1' in parents and name = 'it\\'s \\\\ here' and trashed = false");
    assert.equal(calls[0]?.authorization, 'Bearer access-token');
  });

  test('uses the top folder it made before, wherever it was moved', async () => {
    const { drive, calls } = fakeGoogle(() => list(folder('top')));
    assert.equal((await drive.root()).id, 'top');
    assert.equal(
      calls[0]?.url.searchParams.get('q'),
      "name = 'Discord Archives' and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='discordArchiveTool' and value='root' } and trashed = false",
    );
    assert.equal(calls.length, 1);
  });

  test('creates the tagged top folder in My Drive on the first run, and says so', async () => {
    const { drive, calls, logs } = fakeGoogle((call) => (call.method === 'POST' ? Response.json(folder('new-top')) : list()));
    assert.equal((await drive.root()).id, 'new-top');
    assert.deepEqual(JSON.parse(calls[1]?.body ?? ''), {
      name: 'Discord Archives',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
      appProperties: { discordArchiveTool: 'root' },
    });
    assert.deepEqual(logs, ['Created the folder "Discord Archives" in your Google Drive. Move or share it as you like.']);
  });

  test('uploads a new file in chunks, sending no token to the session, and reads Google’s checksum', async () => {
    const path = join(dir, 'file.bin');
    await writeFile(path, '0123456789');
    const { drive, calls } = fakeGoogle((call) => {
      if (call.url.pathname.endsWith('/files') && call.method === 'GET') return list();
      if (call.method === 'POST') return new Response(null, { status: 200, headers: { location: SESSION } });
      if (call.contentRange === 'bytes 8-9/10') return Response.json(file('f', { size: '10', sha256Checksum: 'abc' }));
      const end = call.contentRange?.match(/-(\d+)\//)?.[1];
      return new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
    });

    const saved = await drive.upload('parent-1', 'file.bin', path, 10);
    assert.deepEqual([saved.size, saved.checksum], [10, 'abc']);
    assert.equal(calls[1]?.url.href, `${UPLOAD}/files?uploadType=resumable&fields=id,name,mimeType,size,webViewLink,sha256Checksum`);
    assert.deepEqual(JSON.parse(calls[1]?.body ?? ''), { name: 'file.bin', parents: ['parent-1'] });
    assert.deepEqual(
      calls.slice(2).map((call) => [call.contentRange, call.body, call.authorization]),
      [
        ['bytes 0-3/10', '0123', null],
        ['bytes 4-7/10', '4567', null],
        ['bytes 8-9/10', '89', null],
      ],
    );
  });

  test('replaces a file of the same name instead of adding a second one', async () => {
    const { drive, calls } = fakeGoogle((call) => {
      if (call.method === 'GET') return list(file('existing-run'));
      if (call.method === 'PATCH') return new Response(null, { status: 200, headers: { location: SESSION } });
      return Response.json(file('existing-run'));
    });
    await drive.writeText('folder-1', '_run.json', '{}');
    assert.equal(calls[1]?.method, 'PATCH');
    assert.equal(calls[1]?.url.pathname, '/upload/drive/v3/files/existing-run');
  });

  test('carries on from what Drive says it holds when a chunk only partly arrived', async () => {
    const path = join(dir, 'file.bin');
    await writeFile(path, '01234567');
    let first = true;
    const { drive, calls } = fakeGoogle((call) => {
      if (call.method === 'GET') return list();
      if (call.method === 'POST') return new Response(null, { status: 200, headers: { location: SESSION } });
      if (call.contentRange === 'bytes 0-3/8' && first) {
        first = false;
        return new Response(null, { status: 308, headers: { range: 'bytes=0-1' } });
      }
      if (call.contentRange === 'bytes 6-7/8') return Response.json(file('f', { size: '8' }));
      return new Response(null, { status: 308, headers: { range: `bytes=0-${call.contentRange?.match(/-(\d+)\//)?.[1]}` } });
    });
    await drive.upload('parent-1', 'file.bin', path, 8);
    assert.deepEqual(
      calls.slice(2).map((call) => call.contentRange),
      ['bytes 0-3/8', 'bytes 2-5/8', 'bytes 6-7/8'],
    );
  });

  test('retries Google’s rate-limit 403, but not other 403s', async () => {
    let tries = 0;
    const limited = fakeGoogle(() =>
      ++tries === 1 ? Response.json({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403 }) : Response.json(file('x')),
    );
    assert.equal((await limited.drive.item('x')).id, 'x');
    assert.equal(limited.waits.length, 1);

    const denied = fakeGoogle(() => Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'No access' } }, { status: 403 }));
    await assert.rejects(denied.drive.item('x'), { message: 'Google Drive: No access (PERMISSION_DENIED)' });
    assert.equal(denied.calls.length, 1);
  });

  test('finishes an empty file in one call', async () => {
    const path = join(dir, 'empty.txt');
    await writeFile(path, '');
    const { drive, calls } = fakeGoogle((call) => {
      if (call.method === 'GET') return list();
      if (call.method === 'POST') return new Response(null, { status: 200, headers: { location: SESSION } });
      return Response.json(file('empty', { size: '0' }));
    });
    assert.equal((await drive.upload('parent-1', 'empty.txt', path, 0)).size, 0);
    assert.deepEqual(calls.slice(2).map((call) => call.contentRange), ['bytes */0']);
  });

  test('reads a file back through alt=media', async () => {
    const { drive, calls } = fakeGoogle(() => new Response('hello'));
    assert.equal((await drive.download('f')).size, 5);
    assert.equal(calls[0]?.url.href, `${API}/files/f?alt=media`);
  });
});
