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
// Bare domain.tld catcher. TLD bound is generous (2..24) so newer
// long TLDs (.example, .software, .technology) get caught alongside
// the classic .com/.org. Subdomain segments cap at 40 chars apiece.
const BARE_DOMAIN_PATTERN =
  /\b[a-z][a-z\-]{0,40}(?:\.[a-z][a-z\-]{0,40})*\.[a-z]{2,24}(?:\/\S*)?\b/gi;
// Whole-block strippers for elements whose CONTENT is also dangerous
// (script source code, style rules). Matched non-greedily so two
// adjacent <script> blocks don't merge.
const SCRIPT_BLOCK_PATTERN = /<script[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_PATTERN = /<style[\s\S]*?<\/style>/gi;
const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*?>/gi;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\([^)]*\)/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]*]\([^)]*\)/g;
const CODE_FENCE_PATTERN = /```[\s\S]*?```|`[^`]*`/g;
// HTML entities that could re-introduce stripped content if a future
// renderer eagerly decodes them.
const HTML_ENTITY_PATTERN = /&(?:[a-z]+|#x?[0-9a-f]+);/gi;

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
  let out = guarded
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
    // Encoded entities that could re-introduce content under a
    // future renderer's eager-decode (e.g. `&lt;script&gt;`).
    .replace(HTML_ENTITY_PATTERN, '')
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
