import { open } from 'node:fs/promises';
import { createSend, fail, hashBody, orNull, type Send } from '../http.ts';
import { CHUNK_SIZE, type RemoteItem, type Store } from './store.ts';

// OneDrive through Microsoft Graph, as plain REST. Every path is inside the signed-in account's
// own OneDrive (/me/drive).

const API = 'https://graph.microsoft.com/v1.0/me/drive';
const SERVICE = 'Microsoft Graph';
const FIELDS = 'id,name,size,webUrl,folder,file';
const CHUNK_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
  size?: number;
  folder?: unknown;
  file?: { hashes?: { quickXorHash?: string } };
}

export interface OneDriveOptions {
  token: () => Promise<string>;
  // Folder path in the OneDrive that holds every archive, e.g. "Team/Archives". Must already exist.
  root: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  chunkSize?: number;
}

function toItem(item: DriveItem): RemoteItem {
  return {
    id: item.id,
    name: item.name,
    webUrl: item.webUrl,
    folder: item.folder !== undefined,
    ...(item.size !== undefined ? { size: item.size } : {}),
    checksum: item.file?.hashes?.quickXorHash ?? null,
  };
}

export function createOneDrive(options: OneDriveOptions): Store {
  const send: Send = createSend({ service: SERVICE, token: options.token, fetch: options.fetch, sleep: options.sleep });
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;

  const json = async <T>(url: string, init: { method?: string; body?: string } = {}): Promise<T> => {
    const response = await send(url, { ...init, headers: init.body ? { 'content-type': 'application/json' } : {} });
    if (!response.ok) return fail(SERVICE, response);
    return (await response.json()) as T;
  };
  const item = async (url: string) => toItem(await json<DriveItem>(url));
  const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
  const itemUrl = (id: string) => `${API}/items/${encodeURIComponent(id)}`;
  const childUrl = (parentId: string, name: string) => `${itemUrl(parentId)}:/${encodeURIComponent(name)}:`;

  // A plain PUT replaces any file of that name. Used for small files and empty ones, which an
  // upload session can't take.
  const put = async (parentId: string, name: string, body: Uint8Array) => {
    const response = await send(`${childUrl(parentId, name)}/content`, { method: 'PUT', body });
    if (!response.ok) return fail(SERVICE, response);
    return toItem((await response.json()) as DriveItem);
  };

  const account = async () => {
    const drive = await json<{ owner?: { user?: { displayName?: string; email?: string } } }>(API);
    const user = drive.owner?.user;
    return [user?.displayName, user?.email && `<${user.email}>`].filter(Boolean).join(' ') || 'unknown account';
  };

  return {
    label: 'OneDrive',
    account,

    root: async () => {
      const root = await orNull(item(`${API}/root:/${encodePath(options.root)}`));
      // Never created: a mistyped path must not scatter archives.
      if (!root?.folder) {
        throw new Error(
          `OneDrive folder "${options.root}" was not found in the OneDrive of ${await account()}. ` +
            'Check you signed in with the account that owns it (a folder only shared with you will not work), or fix ONEDRIVE_ROOT.',
        );
      }
      return root;
    },

    item: (id) => item(`${itemUrl(id)}?$select=${FIELDS}`),

    child: (parentId, name) => orNull(item(childUrl(parentId, name))),

    children: async (folderId) => {
      const items: RemoteItem[] = [];
      let url: string | undefined = `${itemUrl(folderId)}/children?$select=${FIELDS}&$top=200`;
      while (url) {
        const page: { value: DriveItem[]; '@odata.nextLink'?: string } = await json(url);
        items.push(...page.value.map(toItem));
        url = page['@odata.nextLink'];
      }
      return items;
    },

    // Fails if anything by that name exists, so the tool never adopts a folder it didn't make.
    createFolder: async (parentId, name) =>
      toItem(
        await json<DriveItem>(`${itemUrl(parentId)}/children`, {
          method: 'POST',
          body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
        }),
      ),

    readText: async (id) => {
      const response = await send(`${itemUrl(id)}/content`);
      if (!response.ok) return fail(SERVICE, response);
      return response.text();
    },

    writeText: (parentId, name, text) => put(parentId, name, new TextEncoder().encode(text)),

    upload: async (parentId, name, localPath, size) => {
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
          if (!response.ok) return fail(SERVICE, response);
          start = end + 1;
          if (start >= size) return toItem((await response.json()) as DriveItem);
          await response.body?.cancel();
        }
      } finally {
        await file.close();
      }
      throw new Error(`Upload of ${name} ended without a result`);
    },

    download: async (id) => {
      const response = await send(`${itemUrl(id)}/content`, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
      if (!response.ok) return fail(SERVICE, response);
      return hashBody(response);
    },
  };
}
