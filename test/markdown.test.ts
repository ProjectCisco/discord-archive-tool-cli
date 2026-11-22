import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderMarkdown } from '../src/markdown.ts';

const render = (raw: string) => renderMarkdown(raw, (escaped) => escaped);

describe('renderMarkdown', () => {
  test('renders bold, italic, underline, strikethrough and spoilers', () => {
    assert.equal(render('**a** *b* _c_ __d__ ~~e~~'), '<strong>a</strong> <em>b</em> <em>c</em> <u>d</u> <s>e</s>');
    assert.equal(render('||hidden||'), '<span class="spoiler" title="Spoiler">hidden</span>');
  });

  test('leaves underscores inside words alone', () => {
    assert.equal(render('snake_case_name'), 'snake_case_name');
  });

  test('keeps code exactly, with no formatting or mentions inside it', () => {
    const seen: string[] = [];
    const html = renderMarkdown('`**not bold** <@1>` and ```js\nconst x = 1 < 2;\n```', (escaped) => {
      seen.push(escaped);
      return escaped;
    });
    assert.equal(html, '<code>**not bold** &lt;@1&gt;</code> and <pre><code>const x = 1 &lt; 2;\n</code></pre>');
    assert.ok(!seen.join('').includes('&lt;@1&gt;'), 'mention replacer never sees code');
  });

  test('renders quotes, headings and subtext', () => {
    assert.equal(render('> quoted\n> more\nafter'), '<blockquote>quoted\nmore</blockquote>after');
    assert.equal(render('before\n>>> rest\nof it'), 'before<blockquote>rest\nof it</blockquote>');
    assert.equal(render('# Big\n## Mid\n### Small\n-# tiny'), '<span class="h1">Big</span>\n<span class="h2">Mid</span>\n<span class="h3">Small</span>\n<span class="sub">tiny</span>');
  });

  test('escapes HTML everywhere, including inside formatting and code', () => {
    const html = render('**<img src=x onerror=alert(1)>** `<script>` > <b>quote</b>');
    assert.ok(!/<(img|script|b)[\s>]/.test(html), html);
    assert.match(html, /<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/);
  });

  test('cannot be tricked by placeholder characters in the message', () => {
    assert.equal(render('\u00000\u0000 `x`'), '0 <code>x</code>');
  });
});

describe('renderMarkdown speed', () => {
  test('stays fast on the worst input Discord allows (4,000 characters of unclosed markers)', () => {
    for (const marker of ['**', '__', '*', '_', '~~', '||', '`', '> ', '# ']) {
      const started = performance.now();
      renderMarkdown(`${marker}a `.repeat(Math.floor(4000 / (marker.length + 2))), (escaped) => escaped);
      assert.ok(performance.now() - started < 500, `${marker} took too long`);
    }
  });
});
