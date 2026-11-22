import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { captureCategory } from './capture.ts';
import { DESTINATIONS, isSnowflake, loadConfig, type Config, type Destination } from './config.ts';
import { audit } from './audit.ts';
import { readRunRecord, uploadToOneDrive, writeRunRecord } from './destinations/onedrive.ts';
import { createDiscord } from './discord.ts';
import { createGraph } from './graph.ts';
import { signIn } from './microsoft.ts';
import { archiveReport } from './report.ts';
import { acquireLock, readState, writeState } from './state.ts';
import { verifyArchive } from './verify.ts';

const USAGE = `Usage:
  npm start -- capture <categoryId>                 Save a category to ARCHIVER_DATA_DIR. Uploads and deletes nothing.
  npm start -- archive <categoryId> --to onedrive   Capture, upload to OneDrive and verify. Deletes nothing.`;

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
  const before = await readState(runDir);
  if (before?.verification?.status === 'verified') {
    throw new Error(`This category is already archived and verified: ${before.upload?.webUrl ?? runDir}`);
  }

  const { treeDir } = await capture(config, categoryId, runDir);
  const state = await readState(runDir);
  if (!state) throw new Error(`No run state in ${runDir} after capture`);

  console.log('\nSign in to Microsoft:');
  const tokens = await signIn({ tenantId: oneDrive.tenantId, clientId: oneDrive.clientId, say: (line) => console.log(line) });
  console.log('Signed in. Uploading…');

  const graph = createGraph({ tokens });
  const discord = createDiscord(config.discordToken);
  const result = await uploadToOneDrive({
    graph,
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

  const folderId = state.upload?.folderId;
  if (!folderId) throw new Error('Upload finished without a folder ID');
  console.log('\nVerifying…');
  const verified = await verifyArchive({ discord, graph, state, treeDir, folderId, log: (line) => console.log(line) });
  const records = Object.values(state.channels);
  const entry = {
    operator: userInfo().username,
    guildId: state.guildId,
    categoryId: state.categoryId,
    categoryName: state.categoryName,
    folder: `${oneDrive.root}/${result.folderName}`,
    webUrl: result.webUrl,
    channels: records.length,
    messages: records.reduce((sum, record) => sum + record.entry.messages, 0),
    files: records.reduce((sum, record) => sum + record.entry.files, 0),
  };
  const at = new Date().toISOString();

  if (!verified.passed) {
    state.verification = { status: 'failed', at, checks: verified.checks, remote: verified.remote };
    await writeState(runDir, state);
    await audit(config.dataDir, {
      event: 'archive-failed',
      ...entry,
      failedChecks: verified.checks.filter((item) => !item.passed).map((item) => item.name),
    });
    for (const item of verified.checks.filter((failed) => !failed.passed)) {
      console.log(`\n✗ ${item.name}`);
      for (const problem of item.problems) console.log(`  - ${problem}`);
    }
    throw new Error(
      'Verification failed, so this archive is not verified and delete will refuse it. ' +
        `If Discord changed since capture, delete ${runDir} and run archive again.`,
    );
  }

  const checks = verified.checks.map((item) => ({ name: item.name, passed: item.passed }));
  await writeRunRecord(graph, folderId, state, 'verified', checks);
  // The run record is what marks the folder as finished, so read it back before trusting it.
  if ((await readRunRecord(graph, folderId))?.status !== 'verified') {
    throw new Error('The run record in OneDrive did not read back as verified');
  }
  state.verification = { status: 'verified', at, checks: verified.checks, remote: verified.remote };
  await writeState(runDir, state);
  await audit(config.dataDir, { event: 'archive-verified', ...entry });

  const report = archiveReport({
    categoryName: state.categoryName,
    destination: 'OneDrive',
    webUrl: result.webUrl,
    channels: records.map((record) => record.entry.name),
    messages: entry.messages,
    files: entry.files,
  });
  console.log('\n✓ Verified: all 4 checks passed. Nothing was deleted.');
  try {
    for (const message of report) await discord.post(config.logChannelId, message);
    console.log('Posted the summary to the log channel.');
  } catch (error) {
    // The archive is verified either way; a missing post must not hide that.
    console.log(`Couldn't post to the log channel: ${(error as Error).message}`);
  }
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
