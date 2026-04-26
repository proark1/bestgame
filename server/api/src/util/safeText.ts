// Hardened safe-text sanitizer for player-authored chat / comments.
//
// The team chat MUST be pure text — no images, no links, no embedded
// HTML, no Markdown formatting that could surface as a clickable URL
// in a future renderer. Both /clan/message and /replay/:id/comments
// pass through this so the rules can't drift between them.
//
// Strategy is allow-list-shaped in spirit: we don't try to enumerate
// every malicious payload, we strip every recognised non-text shape
// (URLs, tags, code fences, images, control chars, repetition spam)
// and cap the result.
//
// Pre-slice to MAX_LEN * 4 BEFORE the regex pass so a multi-megabyte
// hostile payload can't burn server CPU walking the whole string.

export interface SafeTextOptions {
  maxLength: number;
  // Soft anti-spam: cap consecutive identical characters at this
  // count. 'aaaaaaaaaa' -> 'aaaa' when limit is 4.
  maxRepeatRun?: number;
}

export interface SafeTextResult {
  ok: true;
  content: string;
}
export interface SafeTextError {
  ok: false;
  error: string;
}

const URL_PATTERN =
  // http://, https://, ftp://, file://, ws(s)://, gopher://, data:, blob:
  /\b(?:[a-z][a-z0-9+\-.]*:\/\/|data:|blob:|file:|mailto:|ws:|wss:|javascript:)\S+/gi;
const WWW_PATTERN = /\bwww\.\S+/gi;
// Bare domain.tld catcher with bounded repetition. Subdomain segments
// are capped at 3 (so host + up to 3 subdomain dots + TLD = at most 5
// segments) to keep the regex strictly linear — no nested * to
// backtrack on. The optional path tail is also length-bounded so a
// crafted "domain.com/" + 1 MB of `/x` characters can't blow the
// engine. Pre-slice in sanitizeSafeText still caps total input.
const BARE_DOMAIN_PATTERN =
  /\b[a-z][a-z\-]{0,40}(?:\.[a-z][a-z\-]{0,40}){0,3}\.[a-z]{2,24}(?:\/[^\s/]{0,80}){0,4}\b/gi;
// Whole-block strippers for elements whose CONTENT is also dangerous
// (script source code, style rules). Matched non-greedily so two
// adjacent <script> blocks don't merge.
const SCRIPT_BLOCK_PATTERN = /<script[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_PATTERN = /<style[\s\S]*?<\/style>/gi;
const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*?>/gi;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\([^)]*\)/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]*]\([^)]*\)/g;
const CODE_FENCE_PATTERN = /```[\s\S]*?```|`[^`]*`/g;
// Common HTML entities — decoded into the literal characters they
// represent BEFORE tag-stripping runs so `&lt;script&gt;…` becomes
// `<script>…` and falls into the block stripper. That preserves
// legitimate text like "Tom &amp; Jerry" → "Tom & Jerry" while
// closing the entity-encoded XSS round-trip.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
function decodeCommonEntities(s: string): string {
  return s
    .replace(/&([a-z]+);/gi, (m, name: string) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v !== undefined ? v : m;
    })
    .replace(/&#(\d{1,7});/g, (_m, dec: string) => {
      const n = Number(dec);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
      return String.fromCodePoint(n);
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, hex: string) => {
      const n = parseInt(hex, 16);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
      return String.fromCodePoint(n);
    });
}

const DEFAULT_OPTIONS: Required<SafeTextOptions> = {
  maxLength: 400,
  maxRepeatRun: 6,
};

export function sanitizeSafeText(
  raw: unknown,
  options: SafeTextOptions = { maxLength: DEFAULT_OPTIONS.maxLength },
): SafeTextResult | SafeTextError {
  if (typeof raw !== 'string') return { ok: false, error: 'content required' };
  const opts = { ...DEFAULT_OPTIONS, ...options };
  // Pre-slice CPU guard. The regex passes below are linear but many,
  // and a hostile multi-megabyte string would still dominate CPU
  // before the .slice() at the end clipped the output. Cap to 4×
  // the legit max so paste-of-a-paragraph still works.
  const guarded = raw.slice(0, opts.maxLength * 4);
  // Decode common HTML entities BEFORE the block / tag strippers so
  // `&lt;script&gt;…` becomes literal `<script>…` and falls into the
  // block stripper rather than surviving as inert text. This also
  // preserves legitimate uses like `Tom &amp; Jerry` → `Tom & Jerry`.
  const decoded = decodeCommonEntities(guarded);
  let out = decoded
    // Strip ASCII control chars (allows \t \n \r — collapsed below).
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // Strip code fences first so their contents don't survive as
    // bare text (and so URL/tag patterns inside don't double-strip
    // the surrounding markers).
    .replace(CODE_FENCE_PATTERN, '')
    // <script>…</script> and <style>…</style> get block-stripped
    // BEFORE the per-tag pass so the inner code source goes too.
    // The per-tag pass below would otherwise leave the JS body as
    // bare text.
    .replace(SCRIPT_BLOCK_PATTERN, '')
    .replace(STYLE_BLOCK_PATTERN, '')
    // Markdown images BEFORE links — image syntax is `![…](…)` and
    // would otherwise match the link pattern minus the `!`.
    .replace(MARKDOWN_IMAGE_PATTERN, '')
    .replace(MARKDOWN_LINK_PATTERN, '')
    // HTML tags: `<a href=…>`, `<img src=…>`, etc. Pass twice so
    // nested-looking shapes still drop on the second walk; cheap on
    // already-clean strings.
    .replace(HTML_TAG_PATTERN, '')
    .replace(HTML_TAG_PATTERN, '')
    // URL-shaped tokens — protocol://…, www.…, bare domain.tld
    .replace(URL_PATTERN, '')
    .replace(WWW_PATTERN, '')
    .replace(BARE_DOMAIN_PATTERN, '')
    // Anti-spam repetition cap. `(.)\1{N,}` collapses any char
    // repeated more than maxRepeatRun times. Keeps real laughter
    // ("hahaha") readable but kills wallpaper attacks.
    .replace(
      new RegExp(`(.)\\1{${opts.maxRepeatRun},}`, 'g'),
      (_m, c: string) => c.repeat(opts.maxRepeatRun),
    )
    // Whitespace normalisation last so it cleans up the gaps the
    // strippers leave behind.
    .replace(/\s+/g, ' ')
    .trim();
  out = out.slice(0, opts.maxLength);
  if (out.length === 0) {
    return { ok: false, error: 'content cannot be empty' };
  }
  return { ok: true, content: out };
}
