import { open } from 'node:fs/promises';
import { createSend, fail, hashBody, type Send } from '../http.ts';
import { CHUNK_SIZE, type RemoteItem, type Store } from './store.ts';

// Google Drive through the Drive v3 REST API, with the drive.file permission: the tool sees only
// files it created itself. So it makes its own top folder.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SERVICE = 'Google Drive';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,webViewLink,sha256Checksum';
// For one request that carries a chunk of file bytes.
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
// Marks the top folder, so a category folder with the same name inside it can never be mistaken for it.
const ROOT_TAG = "appProperties has { key='discordArchiveTool' and value='root' }";
// Google reports some throttling as 403 with one of these reasons.
const RATE_LIMITS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
  sha256Checksum?: string;
}

export interface GoogleDriveOptions {
  token: () => Promise<string>;
  // Name of the top folder the tool creates in My Drive on its first run, e.g. "Discord Archives".
  rootName: string;
  log: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  chunkSize?: number;
}

function toItem(file: DriveFile): RemoteItem {
  return {
    id: file.id,
    name: file.name,
    webUrl: file.webViewLink ?? '',
    folder: file.mimeType === FOLDER,
    ...(file.size !== undefined ? { size: Number(file.size) } : {}),
    checksum: file.sha256Checksum ?? null,
  };
}

// Drive search strings are quoted with ' and escaped with \.
function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function throttled(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const body = (await response.json().catch(() => ({}))) as { error?: { errors?: Array<{ reason?: string }> } };
  return body.error?.errors?.some((error) => RATE_LIMITS.has(error.reason ?? '')) ?? false;
}

export function createGoogleDrive(options: GoogleDriveOptions): Store {
  const send: Send = createSend({ service: SERVICE, token: options.token, fetch: options.fetch, sleep: options.sleep, throttled });
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;

  const json = async <T>(url: string, init: { method?: string; body?: string } = {}): Promise<T> => {
    const response = await send(url, { ...init, headers: init.body ? { 'content-type': 'application/json' } : {} });
    if (!response.ok) return fail(SERVICE, response);
    return (await response.json()) as T;
  };

  const search = async (query: string): Promise<RemoteItem[]> => {
    const items: RemoteItem[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: `${query} and trashed = false`, fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000', spaces: 'drive' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await json<{ files: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`);
      items.push(...page.files.map(toItem));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return items;
  };

  // Drive allows two items with the same name in one folder. The tool won't guess between them.
  const one = (items: RemoteItem[], what: string): RemoteItem | null => {
    if (items.length > 1) throw new Error(`Google Drive has ${items.length} items named ${what}. Rename or remove the extras, then run again.`);
    return items[0] ?? null;
  };

  const child = (parentId: string, name: string) => search(`${quote(parentId)} in parents and name = ${quote(name)}`).then((items) => one(items, `"${name}" in one folder`));

  const createFolder = async (parentId: string, name: string, tags: Record<string, string> = {}) =>
    toItem(
      await json<DriveFile>(`${API}/files?fields=${FIELDS}`, {
        method: 'POST',
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId], appProperties: tags }),
      }),
    );

  // Starts an upload that replaces the file of that name, or creates it. Drive would otherwise
  // happily keep two files with the same name side by side.
  const startUpload = async (parentId: string, name: string): Promise<string> => {
    const existing = await child(parentId, name);
    const response = existing
      ? await send(`${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=${FIELDS}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      : await send(`${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, parents: [parentId] }),
        });
    if (!response.ok) return fail(SERVICE, response);
    const location = response.headers.get('location');
    if (!location) throw new Error(`Google Drive gave no upload address for ${name}`);
    return location;
  };

  // Sends bytes to an upload session in chunks. Drive answers 308 until the last chunk.
  const sendChunks = async (session: string, size: number, read: (buffer: Uint8Array, start: number) => Promise<number>) => {
    if (size === 0) {
      const response = await send(session, { method: 'PUT', auth: false, headers: { 'content-range': 'bytes */0' }, body: new Uint8Array() });
      if (!response.ok) return fail(SERVICE, response);
      return toItem((await response.json()) as DriveFile);
    }
    const buffer = new Uint8Array(Math.min(chunkSize, size));
    let stalls = 0;
    for (let start = 0; ; ) {
      const bytesRead = await read(buffer.subarray(0, Math.min(chunkSize, size - start)), start);
      if (bytesRead === 0) throw new Error('The local file is shorter than expected');
      const end = start + bytesRead - 1;
      // The session address is its own authorisation. redirect: manual keeps fetch from treating
      // Drive's "308 Resume Incomplete" as a redirect.
      const response = await send(session, {
        method: 'PUT',
        auth: false,
        redirect: 'manual',
        timeoutMs: UPLOAD_TIMEOUT_MS,
        headers: { 'content-range': `bytes ${start}-${end}/${size}` },
        body: buffer.subarray(0, bytesRead),
      });
      if (response.status !== 308) {
        if (!response.ok) return fail(SERVICE, response);
        if (end + 1 < size) throw new Error('Google Drive finished the upload before every byte was sent');
        return toItem((await response.json()) as DriveFile);
      }
      // 308 says how much Drive holds so far ("bytes=0-N"). Carry on from there, which also
      // covers a chunk that only partly arrived.
      const held = Number(/-(\d+)$/.exec(response.headers.get('range') ?? '')?.[1] ?? -1) + 1;
      await response.body?.cancel();
      stalls = held > start ? 0 : stalls + 1;
      if (stalls >= 3) throw new Error('Google Drive stopped accepting the upload');
      start = held;
    }
  };

  return {
    label: 'Google Drive',

    account: async () => {
      const about = await json<{ user?: { displayName?: string; emailAddress?: string } }>(`${API}/about?fields=user(displayName,emailAddress)`);
      const user = about.user;
      return [user?.displayName, user?.emailAddress && `<${user.emailAddress}>`].filter(Boolean).join(' ') || 'unknown account';
    },

    // Found wherever it has been moved to, since the tool made it. Created in My Drive on the first run.
    root: async () => {
      const found = one(await search(`name = ${quote(options.rootName)} and mimeType = ${quote(FOLDER)} and ${ROOT_TAG}`), `"${options.rootName}" made by this tool`);
      if (found) return found;
      const created = await createFolder('root', options.rootName, { discordArchiveTool: 'root' });
      options.log(`Created the folder "${options.rootName}" in your Google Drive. Move or share it as you like.`);
      return created;
    },

    item: async (id) => toItem(await json<DriveFile>(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`)),

    child,

    children: (folderId) => search(`${quote(folderId)} in parents`),

    createFolder: (parentId, name) => createFolder(parentId, name),

    readText: async (id) => {
      const response = await send(`${API}/files/${encodeURIComponent(id)}?alt=media`);
      if (!response.ok) return fail(SERVICE, response);
      return response.text();
    },

    writeText: async (parentId, name, text) => {
      const bytes = new TextEncoder().encode(text);
      return sendChunks(await startUpload(parentId, name), bytes.byteLength, async (buffer, start) => {
        const part = bytes.subarray(start, start + buffer.byteLength);
        buffer.set(part);
        return part.byteLength;
      });
    },

    upload: async (parentId, name, localPath, size) => {
      const session = await startUpload(parentId, name);
      const file = await open(localPath, 'r');
      try {
        return await sendChunks(session, size, async (buffer, start) => (await file.read(buffer, 0, buffer.byteLength, start)).bytesRead);
      } finally {
        await file.close();
      }
    },

    download: async (id) => {
      const response = await send(`${API}/files/${encodeURIComponent(id)}?alt=media`);
      if (!response.ok) return fail(SERVICE, response);
      return hashBody(response);
    },
  };
}
