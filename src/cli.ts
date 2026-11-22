import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { captureCategory } from './capture.ts';
import { isSnowflake, loadConfig } from './config.ts';
import { createDiscord } from './discord.ts';
import { acquireLock } from './state.ts';

const USAGE = `Usage:
  npm start -- capture <categoryId>    Save a category to ARCHIVER_DATA_DIR. Reads only: uploads and deletes nothing.`;

async function capture(categoryId: string): Promise<void> {
  const config = loadConfig(process.env, null);
  const runDir = join(config.dataDir, 'runs', categoryId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });

  const release = await acquireLock(runDir);
  try {
    const result = await captureCategory({
      discord: createDiscord(config.discordToken),
      categoryId,
      runDir,
      operator: userInfo().username,
      log: (line) => console.log(line),
    });
    console.log(
      `\nCaptured "${result.categoryName}": ${result.channels} channels, ${result.messages} messages, ${result.files} files.`,
    );
    if (result.converted > 0) {
      console.log(`Saved as the original upload (Discord lists a converted copy): ${result.converted}. See _index.html.`);
    }
    if (result.misses.length > 0) console.log(`Not saved (best effort only): ${result.misses.length}. See _index.html.`);
    console.log(`Open ${join(result.treeDir, '_index.html')}`);
  } finally {
    await release();
  }
}

async function main(): Promise<void> {
  const [command, categoryId] = process.argv.slice(2);
  if (command !== 'capture' || !categoryId) {
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!isSnowflake(categoryId)) throw new Error(`"${categoryId}" is not a Discord ID`);
  await capture(categoryId);
}

main().catch((error: unknown) => {
  console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
