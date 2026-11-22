import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createOneDrive } from '../src/destinations/onedrive.ts';
import { RemoteError } from '../src/http.ts';

const API = 'https://graph.microsoft.com/v1.0/me/drive';

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  contentRange: string | null;
  body: Uint8Array | null;
  text: string | null;
}

function fakeGraph(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : null;
    const call = {
      method: init?.method ?? 'GET',
      url: String(url),
      authorization: headers.get('authorization'),
      contentRange: headers.get('content-range'),
      body,
      text: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  const graph = createOneDrive({
    token: async () => 'access-token',
    root: 'Team #1/Archives & Logs',
    fetch: http,
    sleep: async (ms) => {
      waits.push(ms);
    },
    chunkSize: 4,
  });
  return { graph, calls, waits };
}

const item = (id: string, extra: object = {}) => Response.json({ id, name: id, webUrl: `https://onedrive.test/${id}`, ...extra });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'graph-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createOneDrive', () => {
  test('finds the archive root by path, encoding every segment and sending the token', async () => {
    const { graph, calls } = fakeGraph(() => item('root', { folder: {} }));
    await graph.root();
    assert.equal(calls[0]?.url, `${API}/root:/Team%20%231/Archives%20%26%20Logs`);
    assert.equal(calls[0]?.authorization, 'Bearer access-token');
  });

  test('never creates a missing root, and names the account it looked in', async () => {
    const { graph, calls } = fakeGraph((call) =>
      call.url === API
        ? Response.json({ owner: { user: { displayName: 'Archive Owner', email: 'owner@example.test' } } })
        : Response.json({ error: { code: 'itemNotFound', message: 'gone' } }, { status: 404 }),
    );
    await assert.rejects(graph.root(), /"Team #1\/Archives & Logs" was not found in the OneDrive of Archive Owner <owner@example.test>/);
    assert.ok(calls.every((call) => call.method === 'GET'));
  });

  test('returns null for a missing item and names the Graph error otherwise', async () => {
    const missing = fakeGraph(() => Response.json({ error: { code: 'itemNotFound', message: 'gone' } }, { status: 404 }));
    assert.equal(await missing.graph.child('parent', 'nothing'), null);

    const denied = fakeGraph(() => Response.json({ error: { code: 'accessDenied', message: 'Access denied' } }, { status: 403 }));
    await assert.rejects(denied.graph.child('parent', 'x'), (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.status, 403);
      assert.equal(error.message, 'Microsoft Graph: Access denied (accessDenied)');
      return true;
    });
  });

  test('waits as long as Graph asks when throttled, then carries on', async () => {
    let tries = 0;
    const { graph, waits } = fakeGraph(() =>
      ++tries < 3 ? new Response(null, { status: 429, headers: { 'retry-after': '7' } }) : item('done'),
    );
    assert.equal((await graph.child('parent', 'x'))?.id, 'done');
    assert.deepEqual(waits, [7000, 7000]);

    // A request to wait an hour is capped at two minutes.
    let again = 0;
    const capped = fakeGraph(() => (++again < 2 ? new Response(null, { status: 503, headers: { 'retry-after': '3600' } }) : item('done')));
    await capped.graph.child('parent', 'x');
    assert.deepEqual(capped.waits, [120_000]);
  });

  test('gives up after five tries', async () => {
    const { graph, calls } = fakeGraph(() => new Response(null, { status: 503 }));
    await assert.rejects(graph.child('parent', 'x'), /HTTP 503/);
    assert.equal(calls.length, 5);
  });

  test('creates folders that fail on a name clash instead of merging', async () => {
    const { graph, calls } = fakeGraph(() => item('new', { folder: {} }));
    await graph.createFolder('parent', 'Archive');
    assert.equal(calls[0]?.url, `${API}/items/parent/children`);
    assert.deepEqual(JSON.parse(calls[0]?.text ?? ''), {
      name: 'Archive',
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    });
  });

  test('uploads in chunks with exact ranges, sending no token to the upload URL', async () => {
    const path = join(dir, 'file.bin');
    await writeFile(path, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const { graph, calls } = fakeGraph((call) => {
      if (call.url.endsWith('/createUploadSession')) return Response.json({ uploadUrl: 'https://upload.test/session' });
      if (call.contentRange === 'bytes 8-9/10') return item('file', { size: 10 });
      return Response.json({ nextExpectedRanges: [] }, { status: 202 });
    });

    const saved = await graph.upload('parent', 'a b.bin', path, 10);
    assert.equal(saved.id, 'file');
    assert.equal(calls[0]?.url, `${API}/items/parent:/a%20b.bin:/createUploadSession`);
    const chunks = calls.slice(1);
    assert.deepEqual(
      chunks.map((call) => [call.contentRange, [...(call.body ?? [])], call.authorization]),
      [
        ['bytes 0-3/10', [1, 2, 3, 4], null],
        ['bytes 4-7/10', [5, 6, 7, 8], null],
        ['bytes 8-9/10', [9, 10], null],
      ],
    );
  });

  test('uploads an empty file with a plain PUT, since a session cannot take one', async () => {
    const path = join(dir, 'empty.txt');
    await writeFile(path, '');
    const { graph, calls } = fakeGraph(() => item('empty', { size: 0 }));
    await graph.upload('parent', 'empty.txt', path, 0);
    assert.deepEqual(
      calls.map((call) => [call.method, call.url]),
      [['PUT', `${API}/items/parent:/empty.txt:/content`]],
    );
  });
});
