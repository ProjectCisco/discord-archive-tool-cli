# Security

## Reporting a vulnerability

Please report security problems privately. Use GitHub's **Report a vulnerability** button on this repository's **Security** tab. Don't open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within 7 days.

## Supported versions

Only the latest commit on `main` is supported.

## How the tool handles secrets

- The Discord bot token is read from `.env`, which `.gitignore` excludes from git. It is never written to logs, archives, run state or Discord messages.
- Microsoft and Google sign-in use a device code each time you run the tool. No password or token is stored on disk. Google's client secret for this client type can't really be kept secret; it lives in `.env` with everything else.
- Google Drive access is limited to the `drive.file` permission: only files the tool creates.
- Errors name a setting that is missing or invalid, never its value.

## Keeping your setup safe

- Give the bot only the permissions it needs, in the servers where you use it.
- Keep `.env` and `ARCHIVER_DATA_DIR` readable only by your own user account.
- If you think your bot token has leaked, reset it straight away in the Discord Developer Portal.
- Run `npm audit` after every update.
