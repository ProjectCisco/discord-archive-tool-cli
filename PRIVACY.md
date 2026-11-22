# Privacy

This tool runs on your own computer or server, under your own Discord application and your own storage account. The author of this tool never receives, sees or stores any of your data.

## What it reads

From the Discord category you choose:

- channels, threads and forum posts — names, topics, IDs
- messages — text, time sent, edit time, replies, forwards, reactions, pins, embeds, polls, stickers
- authors — display name, username and user ID
- attached files

It reads nothing outside the category you name.

## Where it goes

- **Your computer**, in the folder you set as `ARCHIVER_DATA_DIR`. This is a working copy and a local backup.
- **The destination you choose**, for example your OneDrive.

That is all. The tool has **no telemetry, no analytics and no tracking**. It makes network calls only to Discord and to your chosen destination.

## What it never does

- send data anywhere other than the destination you configure
- store your Discord token, Microsoft password, sign-in codes or Microsoft tokens in an archive, a log or on disk. Microsoft tokens are held in memory for one run only
- write message content to its logs
- load anything from the internet when you open a chat page

## Your responsibilities

If you run this tool, you decide what is archived, where it is kept, who can see it and for how long. That makes you responsible for it under Discord's Developer Terms and Policy and under privacy law, such as UK or EU GDPR. In practice:

- tell your members that channels may be archived, and why
- keep archives private and share them only with people who need them
- keep the working folder (`ARCHIVER_DATA_DIR`) on storage that only you can read, ideally encrypted
- set a retention period, and delete archives when they are no longer needed
- be ready to find and delete a person's data if they, or Discord, ask

See the **Responsible use** section of the [README](README.md).
