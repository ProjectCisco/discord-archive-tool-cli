# discord-archive-tool-cli

A command-line tool that archives a Discord category — every channel, thread and file — checks that the archive is complete and intact, and only then lets you delete the original channels.

Built for server staff who need to keep records (moderation cases, tickets, appeals) without keeping hundreds of old channels open.

> **Status: in testing.** Archive, verify and delete work with OneDrive. Try delete on a throwaway category first.

## How it keeps your data safe

Deleting a Discord channel can't be undone. So nothing is deleted until the archive is proven complete.

One command, `archive`, does it all for one category:

1. **It archives**: it reads every message and file in the category, saves them, uploads them, then checks:
   - every message was captured, with nothing missing at the end of any channel or thread
   - every file downloaded at the size Discord reported
   - every uploaded file reads back with the same size and SHA-256 checksum
   - every folder can be opened at its destination
2. **Then it deletes the channels**: it lists exactly what will go, counts down 10 seconds (Ctrl+C stops it), checks again that nothing changed since the archive (no new messages, channels or threads, and no changed files), and deletes them one at a time. The category itself is kept. `--keep` skips this step.

If any check fails, nothing is deleted and the tool tells you why. A crash at any point is safe: re-running picks up where it stopped.

## What you get

```
<category name>/
  _index.html               start here: every channel, with counts
  <channel>/
    <channel>.html          the whole chat, threads included
    attachments/            the original files
  <forum>/
    <forum>.html            every post on one page, with a list at the top
    attachments/
  _data/                    for the tool, not for reading:
    <channel>.json          Discord's original data, so pages can be rebuilt later
    _manifest-sha256.txt    checksum of every file
    _run.json               "verified" record (at the destination only)
```

Folders and pages are named after the Discord channel. Characters OneDrive can't take become `_`, and a second channel with the same name gets the end of its ID, e.g. `appeal (851068)`. To check every file by hand, run `sha256sum -c _data/_manifest-sha256.txt` in the archive folder.

Each chat page shows who said what and when (in UTC), replies, forwards, edits, pins, reactions, embeds, polls and Discord's text formatting. Each thread appears right under the message that started it. Mentions are shown as names, with the Discord ID kept alongside. The pages never load anything from the internet, and they can't run scripts.

## Destinations

| Destination | Status |
|---|---|
| Microsoft OneDrive (`--to onedrive`) | Archive, verify and delete work |
| Google Drive (`--to google-drive`) | Archive, verify and delete work |
| Local folder on your computer | Planned |

## Requirements

- **Node.js 24.22.3** or a later 24.x release. `npm install` refuses other versions.
- **Your own Discord application** (bot), added to your server, with **Message Content Intent** turned on in the Developer Portal.
- For OneDrive: a **Microsoft Entra app registration** with *Allow public client flows* turned on and the delegated `Files.ReadWrite` permission.
- For Google Drive: a **Google Cloud project** with the **Google Drive API** turned on and an **OAuth client ID** of type *TVs and Limited Input devices*. The tool asks only for the `drive.file` permission: it can see and change only the files it creates, nothing else in your Drive.

Either way, you sign in with a short code each time you run the tool. No password or token is stored.

## Setup

```sh
git clone https://github.com/<you>/discord-archive-tool-cli.git
cd discord-archive-tool-cli
npm install
cp .env.example .env
```

Fill in `.env`. Every setting is explained in `.env.example`. Never commit `.env` — it holds your bot token, and `.gitignore` already excludes it.

## Usage

Turn on Developer Mode in Discord (**User Settings → Advanced**), right-click the category and choose **Copy Category ID**. The category's name becomes the archive folder's name, so set it first, e.g. `2026-11 November`. Then:

```sh
npm start -- archive <categoryId> --to onedrive
npm start -- archive <categoryId> --to google-drive
```

It shows a code to sign in with first. It checks the destination folder can be used, then captures, uploads to `<root>/<category name>/`, and verifies:

1. **Complete capture**: no channel, thread, post or message appeared in Discord since capture, and Discord's message count for each thread matches.
2. **Files downloaded**: every local file matches the manifest, and every attachment is the size Discord reported.
3. **Upload intact**: every file is downloaded back and matches its SHA-256 checksum, and the folder holds nothing extra.
4. **Folders reachable**: the archive folder and every channel folder have an address you can open.

If all four pass, `_data/_run.json` in the archive folder is set to `verified`, an entry goes in `ARCHIVER_DATA_DIR/audit.jsonl`, and a summary is posted to `DISCORD_LOG_CHANNEL_ID`. It then lists the channels, counts down 10 seconds (Ctrl+C stops it), checks once more, and deletes them (see below). Add `--keep` to archive without deleting. If any check fails, it lists every problem, the archive stays unverified, and nothing is deleted.

- **OneDrive:** `ONEDRIVE_ROOT` must already exist. The tool won't create it, so a typo can't scatter archives.
- **Google Drive:** the tool can only see folders it made itself, so on the first run it creates `GOOGLE_DRIVE_ROOT` in your My Drive. Move or share that folder as you like; the tool still finds it. A folder you made yourself with the same name is invisible to it.
- The tool only writes into a folder it created itself for this same category (it leaves `_data/_run.json` there to tell). It refuses a folder with the same name made by anyone else, or for a different category, and it never changes an archive that is already verified.
- If it stops part-way, run the same command again. Files already uploaded are skipped.
- Browser previews in OneDrive and Google Drive can't follow links between pages or show images. Download the folder, or use the sync app, to browse an archive.

Each file attached to a message must download at exactly the size Discord reports, or the capture stops. Images shown in link previews and stickers are saved when possible; any that can't be saved are listed in `_index.html`.

### Deleting the channels

`archive` deletes as its last step. To delete later instead (after `--keep` or Ctrl+C), carry on after a stop, or only check:

```sh
npm start -- delete <categoryId> --dry-run   # all the checks, deletes nothing
npm start -- delete <categoryId>
```

Running `archive` again on a verified category goes straight to the same step.

Before deleting, the tool checks once more:
- Discord: no new channel, thread, post or message since capture;
- The destination: `_data/_run.json` still says verified, and every file is still there, unchanged (by the service's own checksum), with nothing added.

It lists every channel it will delete and counts down 10 seconds; Ctrl+C stops it with nothing deleted. It checks again when the countdown ends, then deletes one channel at a time (threads and forum posts go with their channel). Each deletion is saved to the run state and the audit log as it happens, and the archive's address is given as the reason in the server's audit log.

- The category itself is never deleted, so it can be renamed and reused.
- A channel moved out of the category after the archive is kept. Moving a channel out is how you keep it.
- If anything changed, nothing is deleted. A verified archive is never changed, so to include the change, delete the archive folder in OneDrive and the run folder, then archive again.
- If delete stops part-way (for example, the bot lacks permission on one channel), fix the cause and run it again. It carries on from where it stopped.

## Development

```sh
npm run check   # type check
npm test        # unit tests
npm audit       # known vulnerabilities in dependencies
```

The TypeScript runs directly on Node.js, with no build step. Tests use Node's built-in test runner and never contact Discord, Microsoft or Google.

To see what a category would look like without uploading or deleting anything, `npm start -- capture <categoryId>` saves it to `ARCHIVER_DATA_DIR/runs/<categoryId>/tree/`.

## Responsible use

This tool copies other people's messages. Using it is your responsibility.

- **Only archive servers you run or have permission to manage.**
- **Tell your members.** Say in your server rules that some channels may be archived, what for, and how long you keep archives.
- **Follow Discord's rules.** The bot you create is your application, so Discord's **Developer Terms of Service** and **Developer Policy** apply to you. Both are on [Discord's developer support site](https://support-dev.discord.com). In short: use the data only for the purpose you state, don't share or sell it, keep it secure, and delete it when it's no longer needed or when Discord or the person asks.
- **Follow your local privacy law** (for example UK or EU GDPR). Archives that name real people usually count as personal data. Set a retention period, and be ready to find and delete a person's data if they ask.
- **Keep archives private.** Share archive folders only with named people. Never use public or "anyone with the link" sharing.

This is not legal advice. If you are unsure, ask someone qualified.

## Privacy and security

- [PRIVACY.md](PRIVACY.md) — what data the tool handles, where it goes, and what it never does.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability, and how the tool handles secrets.

## Licence

[MIT](LICENSE)
