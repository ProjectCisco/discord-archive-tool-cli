import { escapeHtml } from './html.ts';

// Discord's message formatting, rendered from text that is escaped first. Every tag below is a fixed
// string added by this module, so user content can never introduce markup of its own.

const CODE_BLOCK = /```(?:[\w+-]*\n)?([\s\S]*?)```/g;
const INLINE_CODE = /``([^`]+?)``|`([^`\n]+?)`/g;
const PLACEHOLDER = /\u0000(\d+)\u0000/g;

export function renderMarkdown(raw: string, inline: (escaped: string) => string): string {
  // Code keeps its text exactly, so it is set aside before any other formatting runs.
  const kept: string[] = [];
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`;

  const text = escapeHtml(raw.replaceAll('\u0000', ''))
    .replace(CODE_BLOCK, (_, code: string) => keep(`<pre><code>${code}</code></pre>`))
    .replace(INLINE_CODE, (_, doubled: string | undefined, single: string | undefined) =>
      keep(`<code>${doubled ?? single ?? ''}</code>`),
    );

  return inline(emphasis(blocks(text))).replace(PLACEHOLDER, (_, index: string) => kept[Number(index)] ?? '');
}

function blocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (quote.length > 0) out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
    quote = [];
  };

  for (const [index, line] of lines.entries()) {
    if (line.startsWith('&gt;&gt;&gt; ')) {
      flush();
      out.push(`<blockquote>${[line.slice('&gt;&gt;&gt; '.length), ...lines.slice(index + 1)].join('\n')}</blockquote>`);
      return joinLines(out);
    }
    if (line.startsWith('&gt; ')) {
      quote.push(line.slice('&gt; '.length));
      continue;
    }
    flush();
    out.push(heading(line));
  }
  flush();
  return joinLines(out);
}

// A quote is a block of its own, so the line breaks around it would show as blank lines.
function joinLines(parts: string[]): string {
  return parts.join('\n').replace(/\n?(<blockquote>[\s\S]*?<\/blockquote>)\n?/g, '$1');
}

function heading(line: string): string {
  const title = /^(#{1,3}) (.+)$/.exec(line);
  if (title?.[1] && title[2]) return `<span class="h${title[1].length}">${title[2]}</span>`;
  const subtext = /^-# (.+)$/.exec(line);
  if (subtext?.[1]) return `<span class="sub">${subtext[1]}</span>`;
  return line;
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<u>$1</u>')
    .replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>')
    .replace(/(^|\W)_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
    .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" title="Spoiler">$1</span>');
}
