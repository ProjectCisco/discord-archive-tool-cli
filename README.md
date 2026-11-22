# discord-archive-tool-cli

A command-line tool that archives a Discord category — every channel, thread and file — checks that the archive is complete and intact, and only then lets you delete the original channels.

Built for server staff who need to keep records (moderation cases, tickets, appeals) without keeping hundreds of old channels open.

> **Status: in development.** You can capture a category to your own computer now. Uploading, verifying and deleting are being built next. Nothing in this repository can delete anything yet.

## How it keeps your data safe

Deleting a Discord channel can't be undone. So the tool works in two separate commands, and the second one refuses to run unless the first one proved the archive is complete.

1. **`archive`** reads every message and file in the category, saves them, uploads them, then checks:
   - every message was captured, with nothing missing at the end of any channel or thread
   - every file downloaded at the size Discord reported
   - every uploaded file reads back with the same size and SHA-256 checksum
   - every folder can be opened at its destination
2. **`delete`** checks again that nothing has changed since the archive (no new messages, channels or threads, and no changed files), lists exactly what will be deleted, and asks you to type the category name before deleting anything.

If any check fails, nothing is deleted and the tool tells you why. A crash at any point is safe: re-running picks up where it stopped.

## What you get

```
<Category name>/
  _index.html               start here: every channel, with counts
  _manifest-sha256.txt      checksum of every file (check it with: sha256sum -c)
  _run.json                 run record and check results (at the destination only)
  <channel>/
    <channel>.html          the whole chat, threads included. Open this one.
    <channel>.json          Discord's original data, for reprocessing later
    attachments/            the original files
  <forum>/
    <forum>.html            every post on one page, with a list at the top
    <forum>.json
    attachments/
```

Each chat page shows who said what and when (in UTC), replies, forwards, edits, pins, reactions, embeds, polls and Discord's text formatting. Each thread appears right under the message that started it. Mentions are shown as names, with the Discord ID kept alongside. The pages never load anything from the internet, and they can't run scripts.

## Destinations

| Destination | Status |
|---|---|
| Microsoft OneDrive | In development |
| Local folder on your computer | Planned |
| Google Drive | Planned |

## Requirements

- **Node.js 24.22.3** or a later 24.x release. `npm install` refuses other versions.
- **Your own Discord application** (bot), added to your server, with **Message Content Intent** turned on in the Developer Portal.
- For OneDrive: a **Microsoft Entra app registration** with *Allow public client flows* turned on and the delegated `Files.ReadWrite` permission. You sign in with a code each time you run the tool. No Microsoft password or secret is stored.

## Setup

```sh
git clone https://github.com/<you>/discord-archive-tool-cli.git
cd discord-archive-tool-cli
npm install
cp .env.example .env
```

Fill in `.env`. Every setting is explained in `.env.example`. Never commit `.env` — it holds your bot token, and `.gitignore` already excludes it.

## Usage

Turn on Developer Mode in Discord (**User Settings → Advanced**), right-click the category and choose **Copy Category ID**. Then:

```sh
npm start -- capture <categoryId>
```

This saves every channel, thread and forum post in the category to `ARCHIVER_DATA_DIR/runs/<categoryId>/tree/`. Open `_index.html` there to browse it. It only reads from Discord: it uploads nothing and deletes nothing.

If it stops part-way, run the same command again. Channels already saved are skipped.

Each file attached to a message must download at exactly the size Discord reports, or the capture stops. Images shown in link previews and stickers are saved when possible; any that can't be saved are listed in `_index.html`.

## Development

```sh
npm run check   # type check
npm test        # unit tests
npm audit       # known vulnerabilities in dependencies
```

The TypeScript runs directly on Node.js, with no build step. Tests use Node's built-in test runner and never contact Discord or Microsoft.

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
