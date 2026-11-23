import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSend, fetchWithin } from '../src/http.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A server that never answers: the request ends only when it is aborted.
const silent = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  })) as typeof fetch;

describe('fetchWithin', () => {
  test('gives up, saying why, when the server does not start answering in time', async () => {
    await assert.rejects(fetchWithin(5, silent, 'https://slow.test/file'), /no answer within 0\.005 seconds/);
  });

  test('never cuts off an answer that has started, however long the rest takes', async () => {
    let signal: AbortSignal | null | undefined;
    const slowBody = (async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('first part, '));
          await pause(30);
          controller.enqueue(new TextEncoder().encode('and the rest'));
          controller.close();
        },
      });
      return new Response(body);
    }) as typeof fetch;

    const response = await fetchWithin(5, slowBody, 'https://slow.test/big-file');
    assert.equal(await response.text(), 'first part, and the rest');
    assert.equal(signal?.aborted, false);
  });
});

describe('createSend', () => {
  test('tries again when the server did not answer in time', async () => {
    let calls = 0;
    const http = ((url: string | URL | Request, init?: RequestInit) =>
      ++calls === 1 ? silent(url, init) : Promise.resolve(Response.json({ ok: true }))) as typeof fetch;
    const waits: number[] = [];
    const send = createSend({
      service: 'Test Drive',
      token: async () => 'access-token',
      fetch: http,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    const response = await send('https://drive.test/item', { timeoutMs: 5 });
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual([calls, waits], [2, [2000]]);
  });

  test('names the service and the reason when it never answers', async () => {
    const send = createSend({ service: 'Test Drive', token: async () => 'access-token', fetch: silent, sleep: async () => {} });
    await assert.rejects(send('https://drive.test/item', { timeoutMs: 5 }), /^Error: Couldn't reach Test Drive: no answer within 0\.005 seconds$/);
  });
});
