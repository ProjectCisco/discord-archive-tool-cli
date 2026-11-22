import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { signIn } from '../src/microsoft.ts';

const TENANT = '0b8e5f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const CLIENT = '1c9f6a4b-2d3e-4f50-9b8c-1d2e3f4a5b6c';

interface Call {
  url: string;
  form: URLSearchParams;
}

function fakeMicrosoft(tokenReplies: Array<[number, object]>) {
  const calls: Call[] = [];
  const waits: number[] = [];
  let clock = 0;
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    calls.push({ url: String(url), form });
    if (String(url).endsWith('/devicecode')) {
      return Response.json({
        device_code: 'device-123',
        user_code: 'ABCD-EFGH',
        message: 'To sign in, open https://microsoft.com/devicelogin and enter the code ABCD-EFGH.',
        interval: 5,
        expires_in: 900,
      });
    }
    const [status, body] = tokenReplies.shift() ?? [500, {}];
    return Response.json(body, { status });
  }) as typeof fetch;
  return {
    calls,
    waits,
    options: {
      tenantId: TENANT,
      clientId: CLIENT,
      fetch: http,
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
      advance: (ms: number) => {
        clock += ms;
      },
    },
  };
}

const token = (access: string, refresh = 'refresh-1') => [200, { access_token: access, refresh_token: refresh, expires_in: 3600 }] as [number, object];

describe('signIn', () => {
  test('shows Microsoft’s message, waits while pending, slows down when asked, then signs in', async () => {
    const fake = fakeMicrosoft([
      [400, { error: 'authorization_pending' }],
      [400, { error: 'slow_down' }],
      token('access-1'),
    ]);
    const lines: string[] = [];
    const tokens = await signIn({ ...fake.options, say: (line) => lines.push(line) });

    assert.deepEqual(lines, ['To sign in, open https://microsoft.com/devicelogin and enter the code ABCD-EFGH.']);
    assert.deepEqual(fake.waits, [5000, 5000, 10000]);
    assert.equal(await tokens.token(), 'access-1');
    assert.equal(fake.calls[0]?.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`);
    assert.equal(fake.calls[0]?.form.get('scope'), 'https://graph.microsoft.com/Files.ReadWrite offline_access');
    assert.equal(fake.calls[1]?.form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(fake.calls[1]?.form.get('device_code'), 'device-123');
  });

  test('stops when the person declines', async () => {
    const fake = fakeMicrosoft([[400, { error: 'authorization_declined' }]]);
    await assert.rejects(signIn({ ...fake.options, say: () => {} }), /Sign-in was declined/);
  });

  test('stops with Microsoft’s reason when setup is wrong, and never shows the tokens', async () => {
    const fake = fakeMicrosoft([
      [400, { error: 'invalid_client', error_description: 'AADSTS7000218: public client flows are off.\nTrace ID: 1' }],
    ]);
    await assert.rejects(signIn({ ...fake.options, say: () => {} }), (error: Error) => {
      assert.equal(error.message, 'Microsoft sign-in failed: AADSTS7000218: public client flows are off.');
      return true;
    });
  });

  test('gives up when the code expires before anyone signs in', async () => {
    const pending = Array.from({ length: 400 }, () => [400, { error: 'authorization_pending' }] as [number, object]);
    const fake = fakeMicrosoft(pending);
    await assert.rejects(signIn({ ...fake.options, say: () => {} }), /code expired/);
  });

  test('renews the token before it runs out, keeping the refresh token if none comes back', async () => {
    const fake = fakeMicrosoft([token('access-1', 'refresh-1'), [200, { access_token: 'access-2', expires_in: 3600 }], token('access-3', 'refresh-2')]);
    const tokens = await signIn({ ...fake.options, say: () => {} });
    assert.equal(await tokens.token(), 'access-1');

    fake.options.advance(56 * 60_000);
    assert.equal(await tokens.token(), 'access-2');
    assert.equal(fake.calls.at(-1)?.form.get('refresh_token'), 'refresh-1');

    fake.options.advance(56 * 60_000);
    assert.equal(await tokens.token(), 'access-3');
    assert.equal(fake.calls.at(-1)?.form.get('refresh_token'), 'refresh-1', 'kept the earlier refresh token');
  });
});
