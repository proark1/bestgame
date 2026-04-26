import { describe, expect, it } from 'vitest';
import { sanitizeSafeText } from '../src/util/safeText.js';

// Shared text-only sanitiser used by /clan/message and
// /replay/:id/comments. The team chat MUST be pure text — no
// images, no links, no embedded HTML / Markdown. These tests pin
// every recognised non-text shape so a regression can't smuggle a
// URL through into chat.

const opts = { maxLength: 200 };

function clean(raw: unknown): string {
  const r = sanitizeSafeText(raw, opts);
  if (!r.ok) throw new Error(r.error);
  return r.content;
}

describe('sanitizeSafeText — basic shape', () => {
  it('passes plain text untouched (whitespace collapsed)', () => {
    expect(clean('hello world')).toBe('hello world');
    expect(clean('  multiple    spaces  ')).toBe('multiple spaces');
  });

  it('rejects non-string input', () => {
    const r1 = sanitizeSafeText(undefined, opts);
    expect(r1.ok).toBe(false);
    const r2 = sanitizeSafeText(42, opts);
    expect(r2.ok).toBe(false);
  });

  it('rejects empty after sanitisation', () => {
    const r = sanitizeSafeText('   \n\t  ', opts);
    expect(r.ok).toBe(false);
  });
});

describe('sanitizeSafeText — link stripping', () => {
  it('strips http/https URLs', () => {
    expect(clean('check https://evil.example/path?q=1 out')).toBe('check out');
    expect(clean('see http://foo.bar')).toBe('see');
  });

  it('strips other protocol URLs', () => {
    expect(clean('try data:image/png;base64,AAAA now')).toBe('try now');
    expect(clean('open mailto:phish@x.com please')).toBe('open please');
    // ws:// alone produces an empty post-strip — sanitiser returns
    // `ok: false`, which is correct: a message that's nothing but
    // a stripped URL is not legitimate content.
    const r = sanitizeSafeText('ws://attacker:9999', opts);
    expect(r.ok).toBe(false);
  });

  it('strips www. prefixes without protocol', () => {
    expect(clean('visit www.evil.example for details')).toBe('visit for details');
  });

  it('strips bare domain.tld tokens', () => {
    expect(clean('go to evil.example for the goods')).toBe('go to for the goods');
    expect(clean('visit my-site.shop now')).toBe('visit now');
  });
});

describe('sanitizeSafeText — markdown / HTML stripping', () => {
  it('strips Markdown link syntax', () => {
    expect(clean('see [click me](https://x) please')).toBe('see please');
  });

  it('strips Markdown image syntax', () => {
    expect(clean('![alt](data:image/png;base64,xx) gotcha')).toBe('gotcha');
  });

  it('strips <script>…</script> blocks AND their inner source', () => {
    // The whole-block stripper kills the JS body so the source
    // doesn't survive as bare text. <a> and similar inert tags
    // strip the markup but leave the inner text — that's safe.
    expect(clean('hello <script>alert(1)</script> world')).toBe('hello world');
    expect(clean('<a href="x">click</a> me')).toBe('click me');
    const r = sanitizeSafeText('<img src="data:..." />', opts);
    expect(r.ok).toBe(false);
  });

  it('strips HTML entities so a future renderer can\'t resurrect content', () => {
    // After entity-strip + tag-strip, the script payload survives
    // only as plain English text — no `<>` to make the renderer
    // execute it. That's the goal: entity-encoded HTML can never
    // round-trip back into active markup.
    const r = clean('&lt;script&gt;alert(1)&lt;/script&gt; oops');
    expect(r).not.toContain('<');
    expect(r).not.toContain('>');
    expect(r).toContain('oops');
  });

  it('strips code fences and inline backticks', () => {
    expect(clean('here is `evil()` for you')).toBe('here is for you');
    expect(clean('```\nrm -rf /\n``` end')).toBe('end');
  });
});

describe('sanitizeSafeText — anti-spam', () => {
  it('caps repeated characters to maxRepeatRun', () => {
    // Default maxRepeatRun is 6.
    const r = clean('aaaaaaaaaaaaaa stop');
    expect(r).toBe('aaaaaa stop');
  });

  it('preserves natural laughter ("haha")', () => {
    expect(clean('haha that was funny')).toBe('haha that was funny');
  });
});

describe('sanitizeSafeText — caps + DoS guard', () => {
  it('caps varied output to maxLength', () => {
    // Use varied content so the anti-spam repeat-cap doesn't
    // collapse a long input down before the length cap kicks in.
    const lorem = 'lorem ipsum dolor sit amet '.repeat(50);
    const r = clean(lorem);
    expect(r.length).toBeLessThanOrEqual(opts.maxLength);
    expect(r.length).toBeGreaterThan(opts.maxLength - 10);
  });

  it('returns quickly on hostile multi-MB payloads', () => {
    // 5 MB of repeated character — anti-spam will collapse it,
    // but the test point is that it returns FAST regardless of
    // payload size (the pre-slice CPU guard is what does it).
    const huge = 'a'.repeat(5_000_000);
    const start = Date.now();
    const r = sanitizeSafeText(huge, opts);
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content.length).toBeLessThanOrEqual(opts.maxLength);
    expect(elapsed).toBeLessThan(50);
  });
});
