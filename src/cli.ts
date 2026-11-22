import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { captureCategory } from './capture.ts';
import { DESTINATIONS, isSnowflake, loadConfig, type Config, type Destination } from './config.ts';
import { uploadToOneDrive } from './destinations/onedrive.ts';
import { createDiscord } from './discord.ts';
import { createGraph } from './graph.ts';
import { signIn } from './microsoft.ts';
import { acquireLock, readState, writeState } from './state.ts';

const USAGE = `Usage:
  npm start -- capture <categoryId>                 Save a category to ARCHIVER_DATA_DIR. Uploads and deletes nothing.
  npm start -- archive <categoryId> --to onedrive   Capture, then upload to OneDrive. Deletes nothing.`;

async function withRun(config: Config, categoryId: string, work: (runDir: string) => Promise<void>): Promise<void> {
  const runDir = join(config.dataDir, 'runs', categoryId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(runDir);
  try {
    await work(runDir);
  } finally {
    await release();
  }
}

async function capture(config: Config, categoryId: string, runDir: string) {
  const result = await captureCategory({
    discord: createDiscord(config.discordToken),
    categoryId,
    runDir,
    operator: userInfo().username,
    log: (line) => console.log(line),
  });
  console.log(`\nCaptured "${result.categoryName}": ${result.channels} channels, ${result.messages} messages, ${result.files} files.`);
  if (result.converted > 0) {
    console.log(`Saved as the original upload (Discord lists a converted copy): ${result.converted}. See _index.html.`);
  }
  if (result.misses.length > 0) console.log(`Not saved (best effort only): ${result.misses.length}. See _index.html.`);
  return result;
}

async function archive(config: Config, categoryId: string, runDir: string): Promise<void> {
  const oneDrive = config.oneDrive;
  if (!oneDrive) throw new Error('OneDrive settings are missing');

  const { treeDir } = await capture(config, categoryId, runDir);
  const state = await readState(runDir);
  if (!state) throw new Error(`No run state in ${runDir} after capture`);

  console.log('\nSign in to Microsoft:');
  const tokens = await signIn({ tenantId: oneDrive.tenantId, clientId: oneDrive.clientId, say: (line) => console.log(line) });
  console.log('Signed in. Uploading…');

  const result = await uploadToOneDrive({
    graph: createGraph({ tokens }),
    root: oneDrive.root,
    treeDir,
    state,
    save: () => writeState(runDir, state),
    log: (line) => console.log(line),
  });
  console.log(
    `\nUploaded to OneDrive: ${oneDrive.root}/${result.folderName} (${result.uploaded} files sent, ${result.skipped} already there).`,
  );
  console.log(result.webUrl);
  console.log('Not verified yet, and nothing was deleted.');
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { to: { type: 'string' } } });
  const [command, categoryId, ...extra] = positionals;
  const to = values.to;
  const valid =
    categoryId !== undefined &&
    extra.length === 0 &&
    ((command === 'capture' && to === undefined) || (command === 'archive' && to !== undefined));
  if (!valid) {
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!isSnowflake(categoryId)) throw new Error(`"${categoryId}" is not a Discord ID`);

  if (command === 'capture') {
    const config = loadConfig(process.env, null);
    await withRun(config, categoryId, async (runDir) => {
      const result = await capture(config, categoryId, runDir);
      console.log(`Open ${join(result.treeDir, '_index.html')}`);
    });
    return;
  }

  if (!DESTINATIONS.includes(to as Destination)) {
    throw new Error(`--to must be one of: ${DESTINATIONS.join(', ')}`);
  }
  const config = loadConfig(process.env, to as Destination);
  await withRun(config, categoryId, (runDir) => archive(config, categoryId, runDir));
}

main().catch((error: unknown) => {
  console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
