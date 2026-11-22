// The post in the Discord log channel at the end of a run: what was archived, where, whether it
// was verified, and what happened to the channels.

import { count } from './text.ts';

const LIMIT = 2000;

// Channel names are chosen by server members, so their formatting characters are shown as text.
function plain(text: string): string {
  return text.replace(/[\\*_~|`>[\]]/g, (char) => `\\${char}`);
}


export type DeleteOutcome =
  | { status: 'deleted'; deleted: string[]; kept: string[] }
  | { status: 'kept' }
  | { status: 'stopped' }
  | { status: 'refused' };

export interface RunSummary {
  categoryName: string;
  destination: string;
  webUrl: string;
  channels: Array<{ name: string; messages: number }>;
  messages: number;
  files: number;
  operator: string;
  at: Date;
  outcome: DeleteOutcome;
}

function outcomeLine(outcome: DeleteOutcome): string {
  switch (outcome.status) {
    case 'deleted':
      return `🗑️ Deleted ${count(outcome.deleted.length, 'channel')} · the category was kept`;
    case 'kept':
      return '⏸️ Channels kept on purpose · nothing deleted';
    case 'stopped':
      return '⏸️ Stopped before deleting · nothing deleted';
    case 'refused':
      return '⚠️ Not deleted · Discord or OneDrive changed after verifying (details in the terminal)';
  }
}

export function runReport(summary: RunSummary): string[] {
  const kept = summary.outcome.status === 'deleted' ? new Set(summary.outcome.kept) : new Set<string>();
  // Discord shows <t:…:f> in each reader's own time zone.
  const when = `<t:${Math.floor(summary.at.getTime() / 1000)}:f>`;
  return splitLines([
    `## 🗄️ ${plain(summary.categoryName)}`,
    `✅ Archived to ${summary.destination} and verified · 4 of 4 checks passed`,
    outcomeLine(summary.outcome),
    `📊 ${count(summary.channels.length, 'channel')} · ${count(summary.messages, 'message')} · ${count(summary.files, 'file')}`,
    `📁 [Open the archive in ${summary.destination}](<${summary.webUrl}>)`,
    '',
    '**Channels**',
    ...summary.channels.map(
      (channel) =>
        `• #${plain(channel.name)} · ${count(channel.messages, 'message')}${kept.has(channel.name) ? ' · kept (moved out of the category)' : ''}`,
    ),
    `-# ${plain(summary.operator)} · ${when}`,
  ]);
}

// Discord's limit is 2,000 characters a message. Lines are kept whole.
export function splitLines(lines: string[], limit = LIMIT): string[] {
  const messages: string[] = [];
  let current = '';
  for (const raw of lines) {
    const line = raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
    const next = current === '' ? line : `${current}\n${line}`;
    if (next.length > limit) {
      messages.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current !== '') messages.push(current);
  return messages;
}
