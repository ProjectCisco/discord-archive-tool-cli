import { parseArgs } from 'node:util';
import { DESTINATIONS, isSnowflake, type Destination } from './config.ts';

export type Command =
  | { name: 'capture'; categoryId: string }
  | { name: 'archive'; categoryId: string; destination: Destination; keep: boolean }
  | { name: 'delete'; categoryId: string; dryRun: boolean };

// Null means the words don't form a command, so the usage text is shown. A command with a bad
// value (an ID that isn't one, an unknown destination) throws with the reason.
export function parseCommand(argv: string[]): Command | null {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { to: { type: 'string' }, 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' } },
  });
  const [name, categoryId, ...extra] = positionals;
  if (!categoryId || extra.length > 0) return null;
  const to = values.to;
  const dryRun = values['dry-run'] === true;
  const keep = values.keep === true;
  if (!isSnowflake(categoryId)) throw new Error(`"${categoryId}" is not a Discord ID`);

  if (name === 'capture' && to === undefined && !dryRun && !keep) return { name, categoryId };
  if (name === 'delete' && to === undefined && !keep) return { name, categoryId, dryRun };
  if (name === 'archive' && to !== undefined && !dryRun) {
    const destination = DESTINATIONS.find((known) => known === to);
    if (!destination) throw new Error(`--to must be one of: ${DESTINATIONS.join(', ')}`);
    return { name, categoryId, destination, keep };
  }
  return null;
}
