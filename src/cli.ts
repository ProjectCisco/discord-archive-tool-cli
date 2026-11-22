import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { captureCategory } from './capture.ts';
import { countdown } from './countdown.ts';
import { DESTINATIONS, isSnowflake, loadConfig, type Config, type Destination } from './config.ts';
import { audit } from './audit.ts';
import { preflightOneDrive, readRunRecord, uploadToOneDrive, writeRunRecord } from './destinations/onedrive.ts';
import { createDiscord } from './discord.ts';
import { createGraph } from './graph.ts';
import { signIn } from './microsoft.ts';
import { safeName } from './names.ts';
import { deleteChannels, plan, recheck, refusal } from './remove.ts';
import { runReport, type DeleteOutcome } from './report.ts';
import { acquireLock, readState, writeState, type RunState } from './state.ts';
import { count } from './text.ts';
import { verifyArchive } from './verify.ts';

const USAGE = `Usage:
  npm start -- capture <categoryId>                        Save a category to ARCHIVER_DATA_DIR. Uploads and deletes nothing.
  npm start -- archive <categoryId> --to onedrive          Capture, upload, verify, then delete the category's channels.
  npm start -- archive <categoryId> --to onedrive --keep   The same, but keep the channels.
  npm start -- delete <categoryId> --dry-run               Check again that the archive is complete and intact. Deletes nothing.
  npm start -- delete <categoryId>                         Delete later, or carry on after a stop. Checks again first.`;

const COUNTDOWN_SECONDS = 10;

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

async function microsoft(config: Config) {
  const oneDrive = config.oneDrive;
  if (!oneDrive) throw new Error('OneDrive settings are missing');
  console.log('Sign in to Microsoft:');
  const tokens = await signIn({ tenantId: oneDrive.tenantId, clientId: oneDrive.clientId, say: (line) => console.log(line) });
  console.log('Signed in.');
  return { oneDrive, graph: createGraph({ tokens }) };
}

// One action: capture, upload, verify, then offer to delete. A run that stopped part-way, or
// was kept without deleting, carries on from where it was.
async function archive(config: Config, categoryId: string, runDir: string, keep: boolean): Promise<void> {
  const before = await readState(runDir);
  if (before?.deletion?.finishedAt) {
    throw new Error(`This category is already archived and deleted: ${before.upload?.webUrl ?? runDir}`);
  }
  const discord = createDiscord(config.discordToken);
  const { oneDrive, graph } = await microsoft(config);

  if (before?.verification?.status === 'verified') {
    console.log(`\nAlready archived and verified: ${before.upload?.webUrl ?? ''}`);
    await deleteAndReport({ config, runDir, state: before, discord, graph, dryRun: keep, checkFirst: true });
    return;
  }

  // Check the destination before spending time on the capture.
  const category = await discord.channel(categoryId);
  if (!category.guild_id) throw new Error(`${categoryId} is not a channel in a server`);
  await preflightOneDrive(graph, oneDrive.root, category.name, { guildId: category.guild_id, categoryId }, (line) =>
    console.log(line),
  );

  console.log('');
  const { treeDir } = await capture(config, categoryId, runDir);
  const state = await readState(runDir);
  if (!state) throw new Error(`No run state in ${runDir} after capture`);

  console.log('\nUploading…');
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
  const entry = auditBase(state, `${oneDrive.root}/${result.folderName}`);
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
      'Verification failed, so nothing was deleted. ' +
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
  console.log('\n✓ Verified: all 4 checks passed.');
  if (keep) {
    console.log('Kept the channels (--keep). Run delete later to remove them.');
    await post(discord, config, report(state, { status: 'kept' }));
    return;
  }
  await deleteAndReport({ config, runDir, state, discord, graph, dryRun: false, checkFirst: false });
}

// The archive is verified either way; a missing post must not hide that.
async function post(discord: ReturnType<typeof createDiscord>, config: Config, messages: string[]): Promise<void> {
  try {
    for (const message of messages) await discord.post(config.logChannelId, message);
    console.log('Posted the summary to the log channel.');
  } catch (error) {
    console.log(`Couldn't post to the log channel: ${(error as Error).message}`);
  }
}

function report(state: RunState, outcome: DeleteOutcome): string[] {
  const records = Object.values(state.channels);
  return runReport({
    categoryName: state.categoryName,
    destination: 'OneDrive',
    webUrl: state.upload?.webUrl ?? '',
    channels: records.map((record) => ({ name: record.entry.name, messages: record.entry.messages })),
    messages: records.reduce((sum, record) => sum + record.entry.messages, 0),
    files: records.reduce((sum, record) => sum + record.entry.files, 0),
    operator: userInfo().username,
    at: new Date(),
    outcome,
  });
}

// One post per run, once the channels' fate is known. A refused delete is posted too: the
// archive is verified, and the log should say why the channels are still there.
async function deleteAndReport(stage: DeleteStage): Promise<void> {
  let outcome: DeleteOutcome | null;
  try {
    outcome = await deleteStage(stage);
  } catch (error) {
    await post(stage.discord, stage.config, report(stage.state, { status: 'refused' }));
    throw error;
  }
  if (outcome) await post(stage.discord, stage.config, report(stage.state, outcome));
}

function auditBase(state: RunState, folder: string) {
  const records = Object.values(state.channels);
  return {
    operator: userInfo().username,
    guildId: state.guildId,
    categoryId: state.categoryId,
    categoryName: state.categoryName,
    folder,
    webUrl: state.upload?.webUrl ?? '',
    channels: records.length,
    messages: records.reduce((sum, record) => sum + record.entry.messages, 0),
    files: records.reduce((sum, record) => sum + record.entry.files, 0),
  };
}

// The standalone command: delete later, carry on after a stop, or --dry-run to check only.
async function remove(config: Config, runDir: string, dryRun: boolean): Promise<void> {
  const state = await readState(runDir);
  const refused = refusal(state);
  if (refused || !state) throw new Error(refused ?? 'No archive');
  const { graph } = await microsoft(config);
  const discord = createDiscord(config.discordToken);
  const outcome = await deleteStage({ config, runDir, state, discord, graph, dryRun, checkFirst: true });
  // Stopping or a dry run changes nothing, so only a delete is posted.
  if (outcome?.status === 'deleted') await post(discord, config, report(state, outcome));
}

interface DeleteStage {
  config: Config;
  runDir: string;
  state: RunState;
  discord: ReturnType<typeof createDiscord>;
  graph: ReturnType<typeof createGraph>;
  dryRun: boolean;
  checkFirst: boolean;
}

// Null for a dry run. Throws, deleting nothing, if the re-check finds a change.
async function deleteStage({ config, runDir, state, discord, graph, dryRun, checkFirst }: DeleteStage): Promise<DeleteOutcome | null> {
  const refused = refusal(state);
  if (refused || !state.upload) throw new Error(refused ?? 'No verified upload');
  const upload = state.upload;
  const base = auditBase(state, `${config.oneDrive?.root ?? ''}/${safeName(state.categoryName)}`);
  const treeDir = join(runDir, 'tree');

  const check = async () => {
    console.log('Checking Discord and OneDrive again…');
    const { problems } = await recheck({ discord, graph, state, treeDir });
    if (problems.length === 0) return;
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    if (!dryRun) await audit(config.dataDir, { event: 'delete-refused', ...base, problems });
    throw new Error(
      'Nothing was deleted: something changed since the archive was verified. A verified archive is never changed, ' +
        `so to include the change, delete the archive folder in OneDrive and ${runDir}, then run archive again.`,
    );
  };
  if (checkFirst) await check();

  const planned = plan(state);
  console.log(`\nThese ${count(planned.length, 'channel')} will be deleted from "${state.categoryName}", with their threads and posts:`);
  for (const channel of planned) {
    console.log(`  #${channel.name}: ${count(channel.messages, 'message')}, ${count(channel.threads, 'thread or post', 'threads or posts')}`);
  }
  console.log(`Archive: ${upload.webUrl}`);
  if (dryRun) {
    console.log('\nDry run: every check passed. Nothing was deleted.');
    return null;
  }

  // No typing (decision D40), but a last chance to stop after seeing the list.
  console.log('');
  if (!(await countdown(COUNTDOWN_SECONDS, (text) => process.stdout.write(text)))) {
    console.log('Stopped. Nothing was deleted. Run delete later to remove them.');
    return { status: 'stopped' };
  }

  // The last look, straight before the first delete.
  await check();
  await audit(config.dataDir, { event: 'delete-confirmed', ...base });
  const result = await deleteChannels({
    discord,
    state,
    reason: `Archived and verified by discord-archive-tool-cli: ${upload.webUrl}`,
    save: () => writeState(runDir, state),
    onDeleted: (channel, outcome) =>
      audit(config.dataDir, { event: 'channel-deleted', ...base, channel: { id: channel.id, name: channel.name, outcome } }),
    log: (line) => console.log(line),
  });
  await audit(config.dataDir, { event: 'delete-done', ...base });

  console.log(`\n✓ Deleted ${count(result.deleted.length, 'channel')}. The category itself was kept.`);
  if (result.skipped.length > 0) console.log(`Kept ${result.skipped.length} that were moved out of the category.`);
  return {
    status: 'deleted',
    deleted: result.deleted.map((channel) => channel.name),
    kept: result.skipped.map((item) => item.channel.name),
  };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { to: { type: 'string' }, 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' } },
  });
  const [command, categoryId, ...extra] = positionals;
  const to = values.to;
  const dryRun = values['dry-run'] === true;
  const keep = values.keep === true;
  const valid =
    categoryId !== undefined &&
    extra.length === 0 &&
    ((command === 'capture' && to === undefined && !dryRun && !keep) ||
      (command === 'archive' && to !== undefined && !dryRun) ||
      (command === 'delete' && to === undefined && !keep));
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

  if (command === 'delete') {
    // The run state says where the archive went; today that is always OneDrive.
    const config = loadConfig(process.env, 'onedrive');
    await withRun(config, categoryId, (runDir) => remove(config, runDir, dryRun));
    return;
  }

  if (!DESTINATIONS.includes(to as Destination)) {
    throw new Error(`--to must be one of: ${DESTINATIONS.join(', ')}`);
  }
  const config = loadConfig(process.env, to as Destination);
  await withRun(config, categoryId, (runDir) => archive(config, categoryId, runDir, keep));
}

main().catch((error: unknown) => {
  console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
