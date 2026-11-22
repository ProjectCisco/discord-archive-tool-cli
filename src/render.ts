import { MessageReferenceType, MessageType } from 'discord-api-types/v10';
import type { APIAttachment, APIEmbed, APIMessage, APIUser } from 'discord-api-types/v10';
import { escapeHtml } from './html.ts';
import { renderMarkdown } from './markdown.ts';
import { fileKey, type Person, type Thread, type Transcript } from './transcript.ts';

const CONVERSATION = new Set<MessageType>([
  MessageType.Default,
  MessageType.Reply,
  MessageType.ChatInputCommand,
  MessageType.ContextMenuCommand,
]);

const SYSTEM_LABELS = new Map<MessageType, string>([
  [MessageType.ChannelPinnedMessage, 'pinned a message'],
  [MessageType.ThreadCreated, 'started a thread'],
  [MessageType.ThreadStarterMessage, 'started this thread from a message in the parent channel'],
  [MessageType.UserJoin, 'joined the server'],
  [MessageType.RecipientAdd, 'added someone to the thread'],
  [MessageType.RecipientRemove, 'removed someone from the thread'],
  [MessageType.ChannelNameChange, 'renamed the channel'],
]);

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif)$/i;

const STYLE = `
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;color:#1f2328;background:#fff}
header.page{padding:16px 24px;border-bottom:1px solid #d0d7de;background:#f6f8fa}
h1{margin:0 0 4px;font-size:20px}
.meta,time,.edited{color:#59636e;font-size:13px}
.meta{margin:0}
main{padding:8px 24px 32px;max-width:960px}
.msg{padding:8px 0;border-bottom:1px solid #eaeef2}
.author{font-weight:600}
time,.edited,.pinned{margin-left:6px}
.pinned{font-size:12px;color:#9a6700}
.content{white-space:pre-wrap;overflow-wrap:anywhere}
.empty,.system{color:#59636e;font-style:italic}
.reply{display:block;font-size:13px;color:#59636e;border-left:3px solid #d0d7de;padding-left:8px;margin:2px 0;text-decoration:none}
.forward{border-left:3px solid #8250df;padding-left:8px;margin:4px 0}
.embed{border-left:4px solid #d0d7de;background:#f6f8fa;padding:8px 12px;margin:6px 0;border-radius:4px}
.embed .title{font-weight:600}
img{max-width:400px;max-height:400px;display:block;margin:4px 0}
.mention{background:#ddf4ff;border-radius:3px;padding:0 2px}
.missing{color:#9a6700}
.reaction{display:inline-block;border:1px solid #d0d7de;border-radius:10px;padding:0 6px;margin:4px 4px 0 0;font-size:12px}
table{border-collapse:collapse}
th,td{padding:4px 12px 4px 0;border-bottom:1px solid #eaeef2;text-align:left}
nav.back{margin:0 0 6px;font-size:13px}
h2{font-size:16px;margin:16px 0 4px}
.thread{margin:4px 0 8px 24px;padding-left:12px;border-left:3px solid #d0d7de}
.post{margin-top:24px;padding-top:8px;border-top:2px solid #d0d7de}
code{background:#f6f8fa;border-radius:3px;padding:0 3px;font-family:ui-monospace,Consolas,monospace;font-size:13px}
pre{background:#f6f8fa;border-radius:4px;padding:8px;margin:4px 0;white-space:pre-wrap}
pre code{padding:0}
blockquote{margin:2px 0;padding-left:10px;border-left:3px solid #d0d7de;color:#424a53}
.spoiler{background:#e6e8eb;border-radius:3px;padding:0 2px}
.h1{font-size:20px;font-weight:700}.h2{font-size:17px;font-weight:700}.h3{font-size:15px;font-weight:700}
.sub{font-size:12px;color:#59636e}
`;

function utc(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? escapeHtml(String(value))
    : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function href(path: string): string {
  return escapeHtml(path.split('/').map(encodeURIComponent).join('/'));
}

function messageCount(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
}

function preview(text: string, length: number): string {
  const chars = Array.from(text);
  return chars.length > length ? `${chars.slice(0, length).join('')}…` : text;
}

function person(user: APIUser, transcript: Transcript): Person {
  return (
    transcript.resolved.users[user.id] ?? {
      id: user.id,
      username: user.username,
      displayName: user.global_name ?? user.username,
    }
  );
}

function formatContent(raw: string, transcript: Transcript): string {
  return renderMarkdown(raw, (escaped) => mentions(escaped, transcript));
}

// Runs on already-escaped text, which is why the patterns match &lt; and &gt;.
function mentions(escaped: string, transcript: Transcript): string {
  const { users, roles, channels } = transcript.resolved;
  const mention = (id: string, label: string) => `<span class="mention" title="${id}">${escapeHtml(label)}</span>`;

  return escaped
    .replace(/&lt;@!?(\d+)&gt;/g, (_, id: string) => mention(id, `@${users[id]?.displayName ?? 'unknown user'}`))
    .replace(/&lt;@&amp;(\d+)&gt;/g, (_, id: string) => mention(id, `@${roles[id] ?? 'unknown role'}`))
    .replace(/&lt;#(\d+)&gt;/g, (_, id: string) => mention(id, `#${channels[id] ?? 'unknown channel'}`))
    .replace(/&lt;a?:(\w+):\d+&gt;/g, ':$1:')
    .replace(/&lt;t:(-?\d+)(?::[tTdDfFR])?&gt;/g, (match, seconds: string) => {
      const date = new Date(Number(seconds) * 1000);
      return Number.isNaN(date.getTime()) ? match : utc(date.getTime());
    });
}

function attachmentList(attachments: APIAttachment[], transcript: Transcript): string {
  return attachments
    .map((attachment) => {
      const name = escapeHtml(attachment.filename);
      const file = transcript.files[attachment.id];
      if (!file) return `<div class="missing">File not archived: ${name}</div>`;
      const isImage = attachment.content_type?.startsWith('image/') ?? IMAGE_EXTENSION.test(attachment.filename);
      return isImage
        ? `<a href="${href(file.path)}"><img src="${href(file.path)}" alt="${name}" loading="lazy"></a>`
        : `<div><a href="${href(file.path)}">📎 ${name}</a> <span class="meta">${file.size.toLocaleString('en-GB')} bytes</span></div>`;
    })
    .join('');
}

function embedList(embeds: APIEmbed[], keyPrefix: string, transcript: Transcript): string {
  return embeds
    .map((embed, index) => {
      const parts: string[] = [];
      if (embed.author?.name) parts.push(`<div class="meta">${escapeHtml(embed.author.name)}</div>`);
      if (embed.title) parts.push(`<div class="title">${escapeHtml(embed.title)}</div>`);
      if (embed.url) parts.push(`<div class="meta">${escapeHtml(embed.url)}</div>`);
      if (embed.description) parts.push(`<div class="content">${formatContent(embed.description, transcript)}</div>`);
      for (const field of embed.fields ?? []) {
        parts.push(
          `<div><strong>${escapeHtml(field.name)}</strong><div class="content">${formatContent(field.value, transcript)}</div></div>`,
        );
      }
      const image = transcript.files[fileKey.embed(keyPrefix, index)];
      if (image) parts.push(`<img src="${href(image.path)}" alt="embed image" loading="lazy">`);
      else if (embed.image || embed.thumbnail) parts.push('<div class="missing">Embed image not archived</div>');
      if (embed.footer?.text) parts.push(`<div class="meta">${escapeHtml(embed.footer.text)}</div>`);
      return `<div class="embed">${parts.join('')}</div>`;
    })
    .join('');
}

function body(content: string, transcript: Transcript): string {
  return content === ''
    ? '<div class="empty">[No text content]</div>'
    : `<div class="content">${formatContent(content, transcript)}</div>`;
}

function replyQuote(message: APIMessage, transcript: Transcript): string {
  if (message.type !== MessageType.Reply) return '';
  const parent = message.referenced_message;
  if (parent === null) return '<div class="reply missing">Replying to a message that was deleted</div>';
  if (parent === undefined) return '<div class="reply missing">Replying to a message that could not be loaded</div>';
  const author = escapeHtml(person(parent.author, transcript).displayName);
  const text = parent.content ? formatContent(preview(parent.content, 200), transcript) : '[No text content]';
  return `<a class="reply" href="#msg-${escapeHtml(parent.id)}">↪ ${author}: ${text}</a>`;
}

function forwardBlock(message: APIMessage, transcript: Transcript): string {
  const reference = message.message_reference;
  if (reference?.type !== MessageReferenceType.Forward) return '';

  const source = reference.channel_id ? transcript.resolved.channels[reference.channel_id] : undefined;
  const author = transcript.resolved.forwardAuthors[message.id];
  const from = source ? `#${escapeHtml(source)}` : 'another channel';
  const by = author ? `originally by ${escapeHtml(author.displayName)}` : 'original author unknown';
  const snapshot = message.message_snapshots?.[0]?.message;
  if (!snapshot) return `<div class="forward"><div class="meta">Forwarded from ${from} · content not available</div></div>`;

  return (
    `<div class="forward"><div class="meta">Forwarded from ${from} · ${by}</div>` +
    body(snapshot.content, transcript) +
    attachmentList(snapshot.attachments, transcript) +
    embedList(snapshot.embeds, `${message.id}:forward`, transcript) +
    '</div>'
  );
}

function extras(message: APIMessage, transcript: Transcript): string {
  const parts: string[] = [];

  for (const sticker of message.sticker_items ?? []) {
    const image = transcript.files[fileKey.sticker(sticker.id)];
    parts.push(
      image
        ? `<img src="${href(image.path)}" alt="sticker: ${escapeHtml(sticker.name)}" loading="lazy">`
        : `<div class="meta">[sticker: ${escapeHtml(sticker.name)}]</div>`,
    );
  }

  const poll = message.poll;
  if (poll) {
    const counts = new Map((poll.results?.answer_counts ?? []).map((answer) => [answer.id, answer.count]));
    const answers = poll.answers
      .map((answer) => `<li>${escapeHtml(answer.poll_media.text ?? '')} — ${counts.get(answer.answer_id) ?? 0}</li>`)
      .join('');
    const state = poll.results?.is_finalized ? 'final results' : 'results at archive time';
    parts.push(
      `<div class="embed"><div class="title">📊 ${escapeHtml(poll.question.text ?? '')}</div><ul>${answers}</ul><div class="meta">${state}</div></div>`,
    );
  }

  const reactions = (message.reactions ?? []).map((reaction) => {
    const emoji = reaction.emoji.id ? `:${reaction.emoji.name ?? 'emoji'}:` : (reaction.emoji.name ?? '?');
    return `<span class="reaction">${escapeHtml(emoji)} ${reaction.count}</span>`;
  });
  if (reactions.length > 0) parts.push(`<div>${reactions.join('')}</div>`);

  return parts.join('');
}

function renderMessage(message: APIMessage, transcript: Transcript): string {
  const author = person(message.author, transcript);
  const name = `<span class="author" title="${escapeHtml(author.username)} · ${escapeHtml(author.id)}">${escapeHtml(author.displayName)}</span>`;
  const time = `<time datetime="${escapeHtml(message.timestamp)}">${utc(message.timestamp)}</time>`;

  if (!CONVERSATION.has(message.type)) {
    const label = SYSTEM_LABELS.get(message.type) ?? `system message (type ${message.type})`;
    const detail = message.content ? `: ${escapeHtml(message.content)}` : '';
    return `<article class="msg system" id="msg-${escapeHtml(message.id)}">${name} ${label}${detail}${time}</article>`;
  }

  const edited = message.edited_timestamp ? `<span class="edited">(edited ${utc(message.edited_timestamp)})</span>` : '';
  const pinned = message.pinned ? '<span class="pinned">📌 pinned</span>' : '';
  const forward = forwardBlock(message, transcript);
  const main = forward !== '' && message.content === '' ? '' : body(message.content, transcript);

  return (
    `<article class="msg" id="msg-${escapeHtml(message.id)}">` +
    `<header>${name}${time}${edited}${pinned}</header>` +
    replyQuote(message, transcript) +
    forward +
    main +
    attachmentList(message.attachments, transcript) +
    embedList(message.embeds, message.id, transcript) +
    extras(message, transcript) +
    '</article>'
  );
}

function page(title: string, header: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="page">${header}</header>
<main>
${content}
</main>
</body>
</html>
`;
}

export function renderTranscript(transcript: Transcript): string {
  const { guild, category, channel, messages, threads } = transcript;
  const total = messages.length + threads.reduce((sum, thread) => sum + thread.messages.length, 0);
  const header =
    '<nav class="back"><a href="../_index.html">← All channels</a></nav>' +
    `<h1>#${escapeHtml(channel.name)}</h1>` +
    `<p class="meta">${escapeHtml(guild.name)} · ${escapeHtml(category.name)} · archived ${utc(transcript.archivedAt)} · ${messageCount(total)}</p>` +
    (channel.topic ? `<p class="meta">${escapeHtml(channel.topic)}</p>` : '');

  return page(
    `#${channel.name} — ${category.name}`,
    header,
    transcript.kind === 'forum' ? forumBody(transcript) : channelBody(transcript),
  );
}

// Each thread sits under the message that started it, as in Discord.
function channelBody(transcript: Transcript): string {
  const byStart = new Map(transcript.threads.flatMap((thread) => (thread.startMessageId ? [[thread.startMessageId, thread]] : [])));
  const placed = new Set<string>();

  const parts = transcript.messages.map((message) => {
    const thread = byStart.get(message.id);
    if (!thread) return renderMessage(message, transcript);
    placed.add(thread.channel.id);
    return renderMessage(message, transcript) + threadSection(thread, transcript);
  });

  const others = transcript.threads.filter((thread) => !placed.has(thread.channel.id));
  if (others.length > 0) {
    parts.push('<h2>Other threads</h2>', ...others.map((thread) => threadSection(thread, transcript)));
  }
  return parts.join('\n');
}

function threadSection(thread: Thread, transcript: Transcript): string {
  return (
    `<section class="thread" id="thread-${escapeHtml(thread.channel.id)}">` +
    `<h2>🧵 ${escapeHtml(thread.channel.name)}</h2>` +
    `<p class="meta">${messageCount(thread.messages.length)}</p>` +
    thread.messages.map((message) => renderMessage(message, transcript)).join('\n') +
    '</section>'
  );
}

// A forum has no messages of its own: a list of posts, then each post in full.
function forumBody(transcript: Transcript): string {
  const started = (post: Thread) => {
    const first = post.messages[0];
    const by = first ? escapeHtml(person(first.author, transcript).displayName) : 'unknown';
    return `${by} · ${first ? utc(first.timestamp) : 'no messages'} · ${messageCount(post.messages.length)}`;
  };

  const list = transcript.threads
    .map((post) => `<li><a href="#post-${escapeHtml(post.channel.id)}">${escapeHtml(post.channel.name)}</a> <span class="meta">${started(post)}</span></li>`)
    .join('');
  const posts = transcript.threads.map(
    (post) =>
      `<section class="post" id="post-${escapeHtml(post.channel.id)}">` +
      `<h2>${escapeHtml(post.channel.name)}</h2><p class="meta">${started(post)}</p>` +
      post.messages.map((message) => renderMessage(message, transcript)).join('\n') +
      '</section>',
  );
  return `<h2>${transcript.threads.length} ${transcript.threads.length === 1 ? 'post' : 'posts'}</h2><ul>${list}</ul>\n${posts.join('\n')}`;
}

export interface IndexEntry {
  name: string;
  path: string;
  messages: number;
  files: number;
  threads: number;
}

export function renderCategoryIndex(input: {
  guildName: string;
  categoryName: string;
  categoryId: string;
  archivedAt: string;
  operator: string;
  entries: IndexEntry[];
  converted: number;
  misses: string[];
}): string {
  const rows = input.entries
    .map(
      (entry) =>
        `<tr><td><a href="${href(entry.path)}">#${escapeHtml(entry.name)}</a></td>` +
        `<td>${entry.messages}</td><td>${entry.files}</td><td>${entry.threads}</td></tr>`,
    )
    .join('');
  const converted =
    input.converted === 0
      ? ''
      : `<p class="meta">${input.converted} ${input.converted === 1 ? 'file was' : 'files were'} saved as the original upload. Discord's own record lists a converted copy with a different size.</p>`;
  const misses =
    input.misses.length === 0
      ? '<p class="meta">Every embed and sticker image was archived.</p>'
      : `<h2>Not archived (best effort only)</h2><ul>${input.misses.map((miss) => `<li>${escapeHtml(miss)}</li>`).join('')}</ul>`;
  const header =
    `<h1>${escapeHtml(input.categoryName)}</h1>` +
    `<p class="meta">${escapeHtml(input.guildName)} · category ${input.categoryId} · archived ${utc(input.archivedAt)} by ${escapeHtml(input.operator)}</p>` +
    '<p class="meta">Click a channel to read it. Each channel\'s folder holds its chat page and its files. The _data folder is for the archive tool; you can ignore it. If links or pictures don\'t open in an online preview, download the folder first.</p>';
  return page(
    input.categoryName,
    header,
    `<table><tr><th>Channel</th><th>Messages</th><th>Files</th><th>Threads / posts</th></tr>${rows}</table>${converted}${misses}`,
  );
}
