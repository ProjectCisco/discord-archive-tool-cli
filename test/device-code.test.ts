import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { googleProvider, microsoftProvider, signIn, type Provider } from '../src/device-code.ts';

const TENANT = '0b8e5f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const CLIENT = '1c9f6a4b-2d3e-4f50-9b8c-1d2e3f4a5b6c';

// Microsoft answers the first call with verification_uri; Google with verification_url.
function fakeProvider(tokenReplies: Array<[number, object]>, start: object = { verification_uri: 'https://example.test/device' }) {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const waits: number[] = [];
  let clock = 0;
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), form: new URLSearchParams(String(init?.body)) });
    if (calls.length === 1) return Response.json({ device_code: 'device-123', user_code: 'ABCD-EFGH', interval: 5, expires_in: 900, ...start });
    const [status, body] = tokenReplies.shift() ?? [500, {}];
    return Response.json(body, { status });
  }) as typeof fetch;
  const options = (provider: Provider, say: (line: string) => void = () => {}) => ({
    provider,
    say,
    fetch: http,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { calls, waits, options, advance: (ms: number) => (clock += ms) };
}

const token = (access: string, refresh = 'refresh-1'): [number, object] => [200, { access_token: access, refresh_token: refresh, expires_in: 3600 }];
const microsoft = microsoftProvider(TENANT, CLIENT);

describe('signIn', () => {
  test('shows the code, waits while pending, slows down when asked, then signs in', async () => {
    const fake = fakeProvider([[400, { error: 'authorization_pending' }], [400, { error: 'slow_down' }], token('access-1')]);
    const lines: string[] = [];
    const tokens = await signIn(fake.options(microsoft, (line) => lines.push(line)));

    assert.deepEqual(lines, ['To sign in to Microsoft, open https://example.test/device and enter the code ABCD-EFGH']);
    assert.deepEqual(fake.waits, [5000, 5000, 10000]);
    assert.equal(await tokens.token(), 'access-1');
    assert.equal(fake.calls[0]?.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`);
    assert.equal(fake.calls[0]?.form.get('scope'), 'https://graph.microsoft.com/Files.ReadWrite offline_access');
    assert.equal(fake.calls[1]?.form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(fake.calls[1]?.form.has('client_secret'), false, 'Microsoft public clients have no secret');
  });

  test('signs in to Google with its own address, the client secret and only the drive.file permission', async () => {
    const fake = fakeProvider([token('access-g')], { verification_url: 'https://www.google.com/device' });
    const lines: string[] = [];
    const tokens = await signIn(fake.options(googleProvider('id.apps.googleusercontent.com', 'client-secret'), (line) => lines.push(line)));
    assert.deepEqual(lines, ['To sign in to Google, open https://www.google.com/device and enter the code ABCD-EFGH']);
    assert.equal(fake.calls[0]?.form.get('scope'), 'https://www.googleapis.com/auth/drive.file');
    assert.equal(fake.calls[1]?.form.get('client_secret'), 'client-secret');
    assert.equal(await tokens.token(), 'access-g');
  });

  test('treats a dropped connection while waiting for the person as one missed poll', async () => {
    const fake = fakeProvider([token('access-1')]);
    let dropped = false;
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (fake.calls.length === 1 && !dropped) {
        dropped = true;
        throw new TypeError('fetch failed');
      }
      return fake.options(microsoft).fetch(url, init);
    }) as typeof fetch;
    const tokens = await signIn({ ...fake.options(microsoft), fetch: flaky });
    assert.equal(await tokens.token(), 'access-1');
  });

  test('stops when the person declines, with either service’s wording', async () => {
    for (const error of ['authorization_declined', 'access_denied']) {
      const fake = fakeProvider([[400, { error }]]);
      await assert.rejects(signIn(fake.options(microsoft)), /Sign-in was declined/);
    }
  });

  test('stops with the service’s reason when setup is wrong', async () => {
    const fake = fakeProvider([[400, { error: 'invalid_client', error_description: 'AADSTS7000218: public client flows are off.\nTrace ID: 1' }]]);
    await assert.rejects(signIn(fake.options(microsoft)), {
      message: 'Microsoft sign-in failed: AADSTS7000218: public client flows are off.',
    });
  });

  test('gives up when the code expires before anyone signs in', async () => {
    const fake = fakeProvider(Array.from({ length: 400 }, (): [number, object] => [400, { error: 'authorization_pending' }]));
    await assert.rejects(signIn(fake.options(microsoft)), /code expired/);
  });

  test('renews the token before it runs out, keeping the refresh token if none comes back', async () => {
    const fake = fakeProvider([token('access-1', 'refresh-1'), [200, { access_token: 'access-2', expires_in: 3600 }], token('access-3', 'refresh-2')]);
    const tokens = await signIn(fake.options(microsoft));
    assert.equal(await tokens.token(), 'access-1');

    fake.advance(56 * 60_000);
    assert.equal(await tokens.token(), 'access-2');
    assert.equal(fake.calls.at(-1)?.form.get('refresh_token'), 'refresh-1');

    fake.advance(56 * 60_000);
    assert.equal(await tokens.token(), 'access-3');
    assert.equal(fake.calls.at(-1)?.form.get('refresh_token'), 'refresh-1', 'kept the earlier refresh token');
  });
});
