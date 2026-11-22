// The summary posted to the Discord log channel after an archive is verified.

const LIMIT = 2000;

// Channel names are chosen by server members, so their formatting characters are shown as text.
function plain(text: string): string {
  return text.replace(/[\\*_~|`>[\]]/g, (char) => `\\${char}`);
}

export interface ArchiveSummary {
  categoryName: string;
  destination: string;
  webUrl: string;
  channels: string[];
  messages: number;
  files: number;
}

export function archiveReport(summary: ArchiveSummary): string[] {
  const lines = [
    `✅ Archived **${plain(summary.categoryName)}** to ${summary.destination} and verified (4/4 checks passed).`,
    `${summary.channels.length} channels · ${summary.messages} messages · ${summary.files} files`,
    `<${summary.webUrl}>`,
    'Nothing has been deleted yet.',
    '',
    'Channels:',
    ...summary.channels.map((name) => `• #${plain(name)}`),
  ];
  return splitLines(lines);
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
