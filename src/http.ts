import { createHash } from 'node:crypto';
import { explain } from './errors.ts';

// HTTP with the retry rules both cloud destinations need: throttling, server errors and dropped
// connections are retried, waiting as long as the server asks, up to five tries.

const MAX_ATTEMPTS = 5;
// A server asking for a longer wait than this gets it capped; the attempt limit still applies.
const MAX_WAIT_MS = 2 * 60_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface HttpOptions {
  service: string;
  token: () => Promise<string>;
  fetch?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  // For services that signal throttling some other way, such as Google's 403 rate-limit errors.
  throttled?: (response: Response) => Promise<boolean>;
}

export interface Request extends RequestInit {
  // False for pre-authorised upload URLs, which must not be sent the token.
  auth?: boolean;
  timeoutMs?: number;
}

export type Send = (url: string, init?: Request) => Promise<Response>;

export function createSend(options: HttpOptions): Send {
  const http = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (url, init = {}) => {
    const { auth = true, timeoutMs = 60_000, ...rest } = init;
    for (let attempt = 1; ; attempt++) {
      const headers = new Headers(rest.headers);
      if (auth) headers.set('authorization', `Bearer ${await options.token()}`);
      let response: Response | null = null;
      try {
        response = await http(url, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(`Couldn't reach ${options.service}: ${explain(error)}`);
      }
      if (response) {
        const retry = RETRY_STATUSES.has(response.status) || (await options.throttled?.(response.clone())) === true;
        if (!retry || attempt >= MAX_ATTEMPTS) return response;
      }
      const retryAfter = Number(response?.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await sleep(Math.min(wait, MAX_WAIT_MS));
    }
  };
}

export class RemoteError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Both services answer errors as { error: { code | status, message } }.
export async function fail(service: string, response: Response): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: unknown; status?: unknown; message?: string } };
  const code = String(body.error?.status ?? body.error?.code ?? 'unknown');
  throw new RemoteError(response.status, `${service}: ${body.error?.message ?? `HTTP ${response.status}`} (${code})`);
}

export async function orNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof RemoteError && error.status === 404) return null;
    throw error;
  }
}

// Streams a download, so a large file never sits in memory.
export async function hashBody(response: Response): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
  }
  return { size, sha256: hash.digest('hex') };
}
