// What a cloud destination provides. The archive rules (which folder may be used, upload order,
// resume, verify, the delete re-check) are written once against this, in archive-folder.ts.

export interface RemoteItem {
  id: string;
  name: string;
  webUrl: string;
  folder: boolean;
  size?: number;
  // The service's own checksum of the stored bytes (OneDrive: quickXorHash, Google: SHA-256).
  // Kept at verify time so delete can check nothing changed without downloading again.
  checksum: string | null;
}

export interface Store {
  label: string;
  // Whose account this is, shown after sign-in so a wrong account is obvious.
  account: () => Promise<string>;
  // The folder every archive goes in.
  root: () => Promise<RemoteItem>;
  item: (id: string) => Promise<RemoteItem>;
  child: (parentId: string, name: string) => Promise<RemoteItem | null>;
  children: (folderId: string) => Promise<RemoteItem[]>;
  createFolder: (parentId: string, name: string) => Promise<RemoteItem>;
  readText: (id: string) => Promise<string>;
  // Both replace a file of the same name.
  writeText: (parentId: string, name: string, text: string) => Promise<RemoteItem>;
  upload: (parentId: string, name: string, localPath: string, size: number) => Promise<RemoteItem>;
  // Reads a file back and returns what actually arrived.
  download: (id: string) => Promise<{ size: number; sha256: string }>;
}

// Upload chunk size. A multiple of 320 KiB (OneDrive) and of 256 KiB (Google): 10 MiB.
export const CHUNK_SIZE = 10 * 1024 * 1024;
