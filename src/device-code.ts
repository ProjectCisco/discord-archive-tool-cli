// Sign-in with the OAuth device code flow (RFC 8628): the tool shows a short code, the person
// enters it in a browser on any device, and the tool polls until they have. Microsoft and Google
// both support it for command-line tools. Tokens stay in memory for one run: nothing is written
// to disk and nothing is ever logged.

const TIMEOUT_MS = 30_000;
// Refresh this long before expiry, so a token never runs out in the middle of an upload.
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface Provider {
  name: string;
  deviceUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: string;
  // Google issues one even to command-line apps; Microsoft public clients have none.
  clientSecret?: string;
}

export interface SignInOptions {
  provider: Provider;
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

const EXPIRED = 'The sign-in code expired before it was used. Run the command again.';
const STOPS: Record<string, string> = {
  authorization_declined: 'Sign-in was declined.',
  access_denied: 'Sign-in was declined.',
  expired_token: EXPIRED,
  bad_verification_code: 'The sign-in code was not recognised. Run the command again.',
};

export function microsoftProvider(tenantId: string, clientId: string): Provider {
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`;
  return {
    name: 'Microsoft',
    deviceUrl: `${base}/devicecode`,
    tokenUrl: `${base}/token`,
    scope: 'https://graph.microsoft.com/Files.ReadWrite offline_access',
    clientId,
  };
}

export function googleProvider(clientId: string, clientSecret: string): Provider {
  return {
    name: 'Google',
    deviceUrl: 'https://oauth2.googleapis.com/device/code',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // Only files this tool creates: it can't see anything else in the Drive.
    scope: 'https://www.googleapis.com/auth/drive.file',
    clientId,
    clientSecret,
  };
}

export async function signIn(options: SignInOptions): Promise<TokenSource> {
  const { provider } = options;
  const http = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const client = { client_id: provider.clientId, ...(provider.clientSecret ? { client_secret: provider.clientSecret } : {}) };

  const post = async (url: string, form: Record<string, string>) => {
    const response = await http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A proxy or outage can answer with HTML; treat that as an error with no details.
    const body: unknown = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  };

  // The description names the provider's error code, which is what you search for when setup is wrong.
  const describe = (body: unknown, status: number) => {
    const error = body as ErrorResponse;
    return error.error_description?.split('\n')[0] ?? error.error ?? `HTTP ${status}`;
  };

  const start = await post(provider.deviceUrl, { client_id: provider.clientId, scope: provider.scope });
  if (!start.ok) throw new Error(`${provider.name} sign-in could not start: ${describe(start.body, start.status)}`);
  const code = start.body as {
    device_code: string;
    user_code: string;
    verification_uri?: string;
    verification_url?: string;
    interval?: number;
    expires_in: number;
  };
  options.say(`To sign in to ${provider.name}, open ${code.verification_uri ?? code.verification_url} and enter the code ${code.user_code}`);

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
    if (now() >= giveUpAt) throw new Error(EXPIRED);
    await sleep(interval);
    // While waiting for the person, a dropped connection is just one missed poll.
    const poll = await post(provider.tokenUrl, {
      ...client,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
    }).catch(() => null);
    if (!poll) continue;
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
    throw new Error(STOPS[error] ?? `${provider.name} sign-in failed: ${describe(poll.body, poll.status)}`);
  }

  const renew = async (refreshToken: string): Promise<string> => {
    const refreshed = await post(provider.tokenUrl, {
      ...client,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: provider.scope,
    });
    if (!refreshed.ok) {
      throw new Error(`The ${provider.name} sign-in could not be renewed: ${describe(refreshed.body, refreshed.status)}`);
    }
    keep(refreshed.body as TokenResponse, refreshToken);
    return (refreshed.body as TokenResponse).access_token;
  };

  // Requests run several at a time, so several can find the token about to expire in the same
  // moment. They share one renewal.
  let renewing: Promise<string> | null = null;
  return {
    token: async () => {
      const held = current;
      if (!held) throw new Error('Not signed in');
      if (held.expiresAt - now() > REFRESH_MARGIN_MS) return held.accessToken;
      if (!held.refreshToken) throw new Error(`The ${provider.name} sign-in has expired. Run the command again.`);
      renewing ??= renew(held.refreshToken).finally(() => {
        renewing = null;
      });
      return renewing;
    },
  };
}
