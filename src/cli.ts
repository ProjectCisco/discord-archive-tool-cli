import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { preflight, readRunRecord, uploadArchive, writeRunRecord } from './archive-folder.ts';
import { audit } from './audit.ts';
import { captureCategory } from './capture.ts';
import { DESTINATIONS, isSnowflake, loadConfig, type Config, type Destination } from './config.ts';
import { countdown } from './countdown.ts';
import { createGoogleDrive } from './destinations/google-drive.ts';
import { createOneDrive } from './destinations/onedrive.ts';
import type { Store } from './destinations/store.ts';
import { googleProvider, microsoftProvider, signIn } from './device-code.ts';
import { createDiscord, type Discord } from './discord.ts';
import { safeName } from './names.ts';
import { deleteChannels, plan, recheck, refusal } from './remove.ts';
import { runReport, type DeleteOutcome } from './report.ts';
import { acquireLock, readState, writeState, type RunState } from './state.ts';
import { count } from './text.ts';
import { verifyArchive } from './verify.ts';

const USAGE = `Usage:
  npm start -- capture <categoryId>                     Save a category locally. Uploads and deletes nothing.
  npm start -- archive <categoryId> --to <destination>  Capture, upload, verify, then delete the category's channels.
  npm start -- archive <categoryId> --to <destination> --keep   The same, but keep the channels.
  npm start -- delete <categoryId> --dry-run            Check again that the archive is complete and intact.
  npm start -- delete <categoryId>                      Delete later, or carry on after a stop. Checks again first.

Destinations: ${DESTINATIONS.join(', ')}`;

const COUNTDOWN_SECONDS = 10;
const log = (line: string) => console.log(line);

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

async function capture(discord: Discord, categoryId: string, runDir: string) {
  const result = await captureCategory({ discord, categoryId, runDir, operator: userInfo().username, log });
  log(`\nCaptured "${result.categoryName}": ${count(result.channels, 'channel')}, ${count(result.messages, 'message')}, ${count(result.files, 'file')}.`);
  if (result.converted > 0) log(`Saved as the original upload (Discord lists a converted copy): ${result.converted}. See _index.html.`);
  if (result.misses.length > 0) log(`Not saved (best effort only): ${result.misses.length}. See _index.html.`);
  return result;
}

async function openStore(config: Config, destination: Destination): Promise<Store> {
  if (destination === 'onedrive') {
    const settings = config.oneDrive;
    if (!settings) throw new Error('OneDrive settings are missing');
    const tokens = await signIn({ provider: microsoftProvider(settings.tenantId, settings.clientId), say: log });
    log('Signed in.');
    return createOneDrive({ token: tokens.token, root: settings.root });
  }
  const settings = config.googleDrive;
  if (!settings) throw new Error('Google Drive settings are missing');
  const tokens = await signIn({ provider: googleProvider(settings.clientId, settings.clientSecret), say: log });
  log('Signed in.');
  return createGoogleDrive({ token: tokens.token, rootName: settings.root, log });
}

// One action: capture, upload, verify, then delete. A run that stopped part-way, or kept its
// channels, carries on from where it was.
async function archive(config: Config, destination: Destination, categoryId: string, runDir: string, keep: boolean): Promise<void> {
  const before = await readState(runDir);
  if (before?.deletion?.finishedAt) throw new Error(`This category is already archived and deleted: ${before.upload?.webUrl ?? runDir}`);
  if (before?.upload && before.upload.destination !== destination) {
    throw new Error(`This category is being archived to ${before.upload.destination}. One category goes to one destination.`);
  }
  const discord = createDiscord(config.discordToken);
  const store = await openStore(config, destination);

  if (before?.verification?.status === 'verified') {
    log(`\nAlready archived and verified: ${before.upload?.webUrl ?? ''}`);
    if (!keep) await deleteAndReport({ config, runDir, state: before, discord, store, dryRun: false, checkFirst: true });
    return;
  }

  // Check the destination before spending time on the capture.
  const category = await discord.channel(categoryId);
  if (!category.guild_id) throw new Error(`${categoryId} is not a channel in a server`);
  await preflight(store, category.name, { guildId: category.guild_id, categoryId }, log);

  log('');
  const { treeDir } = await capture(discord, categoryId, runDir);
  const state = await readState(runDir);
  if (!state) throw new Error(`No run state in ${runDir} after capture`);

  log('\nUploading…');
  const result = await uploadArchive({ store, destination, treeDir, state, save: () => writeState(runDir, state), log });
  log(`\nUploaded to ${store.label}: ${result.folderName} (${result.uploaded} files sent, ${result.skipped} already there).`);
  log(result.webUrl);

  const folderId = state.upload?.folderId;
  if (!folderId) throw new Error('Upload finished without a folder ID');
  log('\nVerifying…');
  const verified = await verifyArchive({ discord, store, state, treeDir, folderId, log });
  const entry = auditBase(state, result.folderName);
  const at = new Date().toISOString();

  if (!verified.passed) {
    state.verification = { status: 'failed', at, checks: verified.checks, remote: verified.remote };
    await writeState(runDir, state);
    const failed = verified.checks.filter((item) => !item.passed);
    await audit(config.dataDir, { event: 'archive-failed', ...entry, failedChecks: failed.map((item) => item.name) });
    for (const item of failed) {
      log(`\n✗ ${item.name}`);
      for (const problem of item.problems) log(`  - ${problem}`);
    }
    throw new Error(`Verification failed, so nothing was deleted. If Discord changed since capture, delete ${runDir} and run archive again.`);
  }

  await writeRunRecord(store, folderId, state, 'verified', verified.checks.map(({ name, passed }) => ({ name, passed })));
  // The run record is what marks the folder as finished, so read it back before trusting it.
  if ((await readRunRecord(store, folderId))?.status !== 'verified') {
    throw new Error(`The run record in ${store.label} did not read back as verified`);
  }
  state.verification = { status: 'verified', at, checks: verified.checks, remote: verified.remote };
  await writeState(runDir, state);
  await audit(config.dataDir, { event: 'archive-verified', ...entry });
  log('\n✓ Verified: all 4 checks passed.');

  if (keep) {
    log('Kept the channels (--keep). Run delete later to remove them.');
    await post(discord, config, report(state, store, { status: 'kept' }));
    return;
  }
  // Verify has only just run, so the re-check before the list would repeat it. The one after the
  // countdown stays.
  await deleteAndReport({ config, runDir, state, discord, store, dryRun: false, checkFirst: false });
}

// The standalone command: delete later, carry on after a stop, or --dry-run to check only.
async function remove(config: Config, runDir: string, dryRun: boolean): Promise<void> {
  const state = await readState(runDir);
  const refused = refusal(state);
  if (refused || !state?.upload) throw new Error(refused ?? 'No verified upload');
  const store = await openStore(config, state.upload.destination);
  const discord = createDiscord(config.discordToken);
  const outcome = await deleteStage({ config, runDir, state, discord, store, dryRun, checkFirst: true });
  // Stopping or a dry run changes nothing, so only a delete is posted.
  if (outcome?.status === 'deleted') await post(discord, config, report(state, store, outcome));
}

interface DeleteStage {
  config: Config;
  runDir: string;
  state: RunState;
  discord: Discord;
  store: Store;
  dryRun: boolean;
  checkFirst: boolean;
}

// One post per run, once the channels' fate is known. A refused delete is posted too: the
// archive is verified, and the log should say why the channels are still there.
async function deleteAndReport(stage: DeleteStage): Promise<void> {
  let outcome: DeleteOutcome | null;
  try {
    outcome = await deleteStage(stage);
  } catch (error) {
    await post(stage.discord, stage.config, report(stage.state, stage.store, { status: 'refused' }));
    throw error;
  }
  if (outcome) await post(stage.discord, stage.config, report(stage.state, stage.store, outcome));
}

// Null for a dry run. Throws, deleting nothing, if the re-check finds a change.
async function deleteStage({ config, runDir, state, discord, store, dryRun, checkFirst }: DeleteStage): Promise<DeleteOutcome | null> {
  const refused = refusal(state);
  if (refused || !state.upload) throw new Error(refused ?? 'No verified upload');
  const upload = state.upload;
  const base = auditBase(state, safeName(state.categoryName));
  const treeDir = join(runDir, 'tree');

  const check = async () => {
    log(`Checking Discord and ${store.label} again…`);
    const problems = await recheck({ discord, store, state, treeDir });
    if (problems.length === 0) return;
    for (const problem of problems) log(`  ✗ ${problem}`);
    if (!dryRun) await audit(config.dataDir, { event: 'delete-refused', ...base, problems });
    throw new Error(
      'Nothing was deleted: something changed since the archive was verified. A verified archive is never changed, ' +
        `so to include the change, delete the archive folder in ${store.label} and ${runDir}, then run archive again.`,
    );
  };
  if (checkFirst) await check();

  const planned = plan(state);
  log(`\nThese ${count(planned.length, 'channel')} will be deleted from "${state.categoryName}", with their threads and posts:`);
  for (const channel of planned) {
    log(`  #${channel.name}: ${count(channel.messages, 'message')}, ${count(channel.threads, 'thread or post', 'threads or posts')}`);
  }
  log(`Archive: ${upload.webUrl}`);
  if (dryRun) {
    log('\nDry run: every check passed. Nothing was deleted.');
    return null;
  }

  // No typing (decision D40), but a last chance to stop after seeing the list.
  log('');
  if (!(await countdown(COUNTDOWN_SECONDS, (text) => process.stdout.write(text)))) {
    log('Stopped. Nothing was deleted. Run delete later to remove them.');
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
    log,
  });
  await audit(config.dataDir, { event: 'delete-done', ...base });

  log(`\n✓ Deleted ${count(result.deleted.length, 'channel')}. The category itself was kept.`);
  if (result.skipped.length > 0) log(`Kept ${result.skipped.length} that were moved out of the category.`);
  return {
    status: 'deleted',
    deleted: result.deleted.map((channel) => channel.name),
    kept: result.skipped.map((item) => item.channel.name),
  };
}

function totals(state: RunState) {
  const records = Object.values(state.channels);
  return {
    channels: records.length,
    messages: records.reduce((sum, record) => sum + record.entry.messages, 0),
    files: records.reduce((sum, record) => sum + record.entry.files, 0),
  };
}

function auditBase(state: RunState, folder: string) {
  return {
    operator: userInfo().username,
    guildId: state.guildId,
    categoryId: state.categoryId,
    categoryName: state.categoryName,
    folder,
    webUrl: state.upload?.webUrl ?? '',
    ...totals(state),
  };
}

function report(state: RunState, store: Store, outcome: DeleteOutcome): string[] {
  const { messages, files } = totals(state);
  return runReport({
    categoryName: state.categoryName,
    destination: store.label,
    webUrl: state.upload?.webUrl ?? '',
    channels: Object.values(state.channels).map((record) => ({ name: record.entry.name, messages: record.entry.messages })),
    messages,
    files,
    operator: userInfo().username,
    at: new Date(),
    outcome,
  });
}

// The archive is verified either way; a missing post must not hide that.
async function post(discord: Discord, config: Config, messages: string[]): Promise<void> {
  try {
    for (const message of messages) await discord.post(config.logChannelId, message);
    log('Posted the summary to the log channel.');
  } catch (error) {
    log(`Couldn't post to the log channel: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { to: { type: 'string' }, 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' } },
  });
  const [command, categoryId, ...extra] = positionals;
  const { to } = values;
  const dryRun = values['dry-run'] === true;
  const keep = values.keep === true;
  const valid =
    categoryId !== undefined &&
    extra.length === 0 &&
    ((command === 'capture' && to === undefined && !dryRun && !keep) ||
      (command === 'archive' && to !== undefined && !dryRun) ||
      (command === 'delete' && to === undefined && !keep));
  if (!valid) {
    log(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!isSnowflake(categoryId)) throw new Error(`"${categoryId}" is not a Discord ID`);

  if (command === 'capture') {
    const config = loadConfig(process.env, null);
    await withRun(config, categoryId, async (runDir) => {
      const result = await capture(createDiscord(config.discordToken), categoryId, runDir);
      log(`Open ${join(result.treeDir, '_index.html')}`);
    });
    return;
  }

  if (command === 'delete') {
    // The run state says where the archive went, so read it before loading that destination's settings.
    const core = loadConfig(process.env, null);
    const destination = (await readState(join(core.dataDir, 'runs', categoryId)))?.upload?.destination;
    if (!destination) throw new Error('No archive of this category exists on this computer. Run archive first.');
    const config = loadConfig(process.env, destination);
    await withRun(config, categoryId, (runDir) => remove(config, runDir, dryRun));
    return;
  }

  const destination = DESTINATIONS.find((name) => name === to);
  if (!destination) throw new Error(`--to must be one of: ${DESTINATIONS.join(', ')}`);
  const config = loadConfig(process.env, destination);
  await withRun(config, categoryId, (runDir) => archive(config, destination, categoryId, runDir, keep));
}

main().catch((error: unknown) => {
  console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
