import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { TokenSource } from './microsoft.ts';

// The Microsoft Graph calls this tool makes, as plain REST.
// Every path is inside the signed-in account's own OneDrive (/me/drive).

const API = 'https://graph.microsoft.com/v1.0/me/drive';
const TIMEOUT_MS = 60_000;
const CHUNK_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const ITEM_FIELDS = 'id,name,size,webUrl,folder,file';
const MAX_ATTEMPTS = 5;
// Upload chunks must be a multiple of 320 KiB. 10 MiB = 32 × 320 KiB.
export const CHUNK_SIZE = 10 * 1024 * 1024;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
  size?: number;
  folder?: unknown;
  file?: { hashes?: { quickXorHash?: string } };
}

export class GraphError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface GraphOptions {
  tokens: TokenSource;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  chunkSize?: number;
}

export function createGraph(options: GraphOptions) {
  const http = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;

  // Retries throttling, server errors and dropped connections, waiting as long as Graph asks.
  const send = async (url: string, init: RequestInit & { auth: boolean; timeoutMs?: number }): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      const headers = new Headers(init.headers);
      if (init.auth) headers.set('authorization', `Bearer ${await options.tokens.token()}`);
      let response: Response | null = null;
      try {
        response = await http(url, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS) });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(`Couldn't reach Microsoft Graph: ${(error as Error).message}`);
      }
      if (response && !RETRY_STATUSES.has(response.status)) return response;
      if (response && attempt >= MAX_ATTEMPTS) return response;
      const retryAfter = Number(response?.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
    }
  };

  const fail = async (response: Response): Promise<never> => {
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const code = body.error?.code ?? 'unknown';
    throw new GraphError(response.status, code, `Microsoft Graph: ${body.error?.message ?? `HTTP ${response.status}`} (${code})`);
  };

  const json = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
    const response = await send(url, {
      ...init,
      auth: true,
      headers: init.body ? { 'content-type': 'application/json' } : {},
    });
    if (!response.ok) return fail(response);
    return (await response.json()) as T;
  };

  const orNull = async <T>(request: Promise<T>): Promise<T | null> => {
    try {
      return await request;
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return null;
      throw error;
    }
  };

  const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
  const childUrl = (parentId: string, name: string) => `${API}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}:`;

  const put = async (parentId: string, name: string, body: Uint8Array): Promise<DriveItem> => {
    const response = await send(`${childUrl(parentId, name)}/content`, { method: 'PUT', auth: true, body });
    if (!response.ok) return fail(response);
    return (await response.json()) as DriveItem;
  };

  return {
    // Whose OneDrive this is. Shown after sign-in, so a wrong account is obvious.
    owner: async (): Promise<string> => {
      const drive = await json<{ owner?: { user?: { displayName?: string; email?: string } } }>(API);
      const user = drive.owner?.user;
      return [user?.displayName, user?.email && `<${user.email}>`].filter(Boolean).join(' ') || 'unknown account';
    },

    // `path` is relative to the root of the OneDrive, e.g. "Team/Archives".
    itemByPath: (path: string) => orNull(json<DriveItem>(`${API}/root:/${encodePath(path)}`)),

    item: (itemId: string) => json<DriveItem>(`${API}/items/${encodeURIComponent(itemId)}?$select=${ITEM_FIELDS}`),

    // Every item directly inside a folder, following Graph's pages to the end.
    children: async (folderId: string): Promise<DriveItem[]> => {
      const items: DriveItem[] = [];
      let url: string | undefined = `${API}/items/${encodeURIComponent(folderId)}/children?$select=${ITEM_FIELDS}&$top=200`;
      while (url) {
        const page: { value: DriveItem[]; '@odata.nextLink'?: string } = await json(url);
        items.push(...page.value);
        url = page['@odata.nextLink'];
      }
      return items;
    },

    // Reads a file back and returns what actually arrived, for comparing with the local copy.
    downloadSha256: async (itemId: string): Promise<{ size: number; sha256: string }> => {
      const response = await send(`${API}/items/${encodeURIComponent(itemId)}/content`, {
        auth: true,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      if (!response.ok || !response.body) return fail(response);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of response.body) {
        hash.update(chunk);
        size += chunk.byteLength;
      }
      return { size, sha256: hash.digest('hex') };
    },

    child: (parentId: string, name: string) => orNull(json<DriveItem>(childUrl(parentId, name))),

    // Fails if anything by that name exists, so the tool never adopts a folder it didn't make.
    createFolder: (parentId: string, name: string) =>
      json<DriveItem>(`${API}/items/${encodeURIComponent(parentId)}/children`, {
        method: 'POST',
        body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      }),

    readText: async (itemId: string): Promise<string> => {
      const response = await send(`${API}/items/${encodeURIComponent(itemId)}/content`, { auth: true });
      if (!response.ok) return fail(response);
      return response.text();
    },

    // Small text the tool writes itself, such as the run record. Replaces any existing file.
    uploadText: (parentId: string, name: string, text: string) => put(parentId, name, new TextEncoder().encode(text)),

    // Archive files: an upload session, sent in chunks, for every size except empty. A chunk that
    // still fails after retries fails the whole file, and the caller starts that file again.
    upload: async (parentId: string, name: string, localPath: string, size: number): Promise<DriveItem> => {
      // An upload session can't take an empty file; a plain PUT can.
      if (size === 0) return put(parentId, name, new Uint8Array());

      const session = await json<{ uploadUrl: string }>(`${childUrl(parentId, name)}/createUploadSession`, {
        method: 'POST',
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
      });

      const file = await open(localPath, 'r');
      try {
        const buffer = new Uint8Array(Math.min(chunkSize, size));
        for (let start = 0; start < size; ) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(chunkSize, size - start), start);
          if (bytesRead === 0) throw new Error(`${localPath} is shorter than expected`);
          const end = start + bytesRead - 1;
          // The upload URL carries its own authorisation. Sending the token as well is refused.
          const response = await send(session.uploadUrl, {
            method: 'PUT',
            auth: false,
            timeoutMs: CHUNK_TIMEOUT_MS,
            headers: { 'content-range': `bytes ${start}-${end}/${size}` },
            body: buffer.subarray(0, bytesRead),
          });
          if (!response.ok) return fail(response);
          start = end + 1;
          if (start >= size) return (await response.json()) as DriveItem;
          await response.body?.cancel();
        }
      } finally {
        await file.close();
      }
      throw new Error(`Upload of ${name} ended without a result`);
    },
  };
}

export type Graph = ReturnType<typeof createGraph>;
