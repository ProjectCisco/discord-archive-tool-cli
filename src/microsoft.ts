// Microsoft sign-in with the OAuth device code flow (RFC 8628), straight against Microsoft Entra.
// Tokens stay in memory for one run. Nothing is written to disk and nothing is ever logged.

const SCOPE = 'https://graph.microsoft.com/Files.ReadWrite offline_access';
const TIMEOUT_MS = 30_000;
// Refresh this long before expiry, so a token never runs out in the middle of an upload.
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface SignInOptions {
  tenantId: string;
  clientId: string;
  // Shows Microsoft's "go to … and enter code …" message.
  say: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface TokenSource {
  token: () => Promise<string>;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
}

const STOPS: Record<string, string> = {
  authorization_declined: 'Sign-in was declined.',
  expired_token: 'The sign-in code expired before it was used. Run the command again.',
  bad_verification_code: 'Microsoft did not recognise the sign-in code. Run the command again.',
};

export async function signIn(options: SignInOptions): Promise<TokenSource> {
  const http = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const base = `https://login.microsoftonline.com/${encodeURIComponent(options.tenantId)}/oauth2/v2.0`;

  const post = async (path: string, form: Record<string, string>) => {
    const response = await http(`${base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A proxy or outage can answer with HTML; treat that as an error with no details.
    const body: unknown = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  };

  const describe = (body: unknown, status: number) => {
    const error = body as ErrorResponse;
    // The description names the AADSTS code, which is what you search for when setup is wrong.
    return error.error_description?.split('\n')[0] ?? error.error ?? `HTTP ${status}`;
  };

  const start = await post('devicecode', { client_id: options.clientId, scope: SCOPE });
  if (!start.ok) throw new Error(`Microsoft sign-in could not start: ${describe(start.body, start.status)}`);
  const code = start.body as { device_code: string; message: string; interval?: number; expires_in: number };
  options.say(code.message);

  let interval = (code.interval ?? 5) * 1000;
  const giveUpAt = now() + code.expires_in * 1000;
  let current: { accessToken: string; refreshToken: string | null; expiresAt: number } | null = null;

  const keep = (body: TokenResponse, previousRefresh: string | null) => {
    current = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? previousRefresh,
      expiresAt: now() + body.expires_in * 1000,
    };
  };

  for (;;) {
    if (now() >= giveUpAt) throw new Error(STOPS['expired_token']);
    await sleep(interval);
    const poll = await post('token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: options.clientId,
      device_code: code.device_code,
    });
    if (poll.ok) {
      keep(poll.body as TokenResponse, null);
      break;
    }
    const error = (poll.body as ErrorResponse).error ?? '';
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new Error(STOPS[error] ?? `Microsoft sign-in failed: ${describe(poll.body, poll.status)}`);
  }

  return {
    token: async () => {
      const held = current;
      if (!held) throw new Error('Not signed in');
      if (held.expiresAt - now() > REFRESH_MARGIN_MS) return held.accessToken;
      if (!held.refreshToken) throw new Error('The Microsoft sign-in has expired. Run the command again.');
      const refreshed = await post('token', {
        grant_type: 'refresh_token',
        client_id: options.clientId,
        refresh_token: held.refreshToken,
        scope: SCOPE,
      });
      if (!refreshed.ok) throw new Error(`The Microsoft sign-in could not be renewed: ${describe(refreshed.body, refreshed.status)}`);
      keep(refreshed.body as TokenResponse, held.refreshToken);
      return (refreshed.body as TokenResponse).access_token;
    },
  };
}
