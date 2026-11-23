import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

// An append-only record of what the tool did, kept outside Discord.
// One JSON object per line. Never holds tokens or message content.

export type AuditEvent =
  | 'archive-verified'
  | 'archive-failed'
  | 'delete-refused'
  | 'delete-confirmed'
  | 'channel-deleted'
  | 'delete-done';

export interface AuditEntry {
  event: AuditEvent;
  operator: string;
  guildId: string;
  categoryId: string;
  categoryName: string;
  folder: string;
  webUrl: string;
  channels: number;
  messages: number;
  files: number;
  failedChecks?: string[];
  problems?: string[];
  channel?: { id: string; name: string; outcome: 'deleted' | 'gone' };
}

export async function audit(dataDir: string, entry: AuditEntry, now = new Date()): Promise<void> {
  await appendFile(join(dataDir, 'audit.jsonl'), `${JSON.stringify({ time: now.toISOString(), ...entry })}\n`, {
    mode: 0o600,
  });
}
