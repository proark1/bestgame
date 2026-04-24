// Soft-launch gate. When the build stamps `VITE_PUBLIC_BETA_GATE=true`
// into the bundle, the game refuses to boot unless the visitor has
// the `?cohort=beta` URL parameter OR `localStorage['hive.cohort']`
// set to `beta`. The first URL visit stamps the flag into
// localStorage so subsequent visits don't need the query string.
//
// Returns `true` when the gate passes (or isn't active) and the boot
// should continue. Returns `false` when the gate is active and
// failed — in that case this function also paints a full-page
// "closed beta" screen over the boot splash so the user sees
// something better than a blank viewport.

const STORAGE_KEY = 'hive.cohort';
const GATE_COHORT = 'beta';

export function enforceBetaGate(): boolean {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  if (env.VITE_PUBLIC_BETA_GATE !== 'true') return true;

  const urlCohort = new URLSearchParams(window.location.search).get('cohort');
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // incognito / blocked storage → fall through; we'll let them in if
    // the URL cohort matches, but they'll need the URL each visit.
  }

  if (urlCohort === GATE_COHORT) {
    try {
      localStorage.setItem(STORAGE_KEY, GATE_COHORT);
    } catch {
      // ignore
    }
    return true;
  }
  if (stored === GATE_COHORT) return true;

  paintClosedBetaScreen();
  return false;
}

function paintClosedBetaScreen(): void {
  // Remove the boot splash and any earlier game canvas first so the
  // closed-beta message is what the user actually sees.
  document.getElementById('boot-splash')?.remove();
  document.getElementById('game')?.replaceChildren();

  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'text-align:center',
    'padding:24px',
    'color:#f7edd0',
    'font-family:"Trebuchet MS",system-ui,-apple-system,sans-serif',
    'background:radial-gradient(circle at 30% 12%, rgba(255,217,138,0.12), transparent 40%),linear-gradient(180deg,#203224 0%,#142117 58%,#060b07 100%)',
    'z-index:100',
  ].join(';');
  el.innerHTML = `
    <div style="font-family:'Arial Black',Impact,sans-serif;font-size:clamp(32px,6vw,52px);color:#ffd98a;letter-spacing:-1px;margin-bottom:14px;">HIVE WARS</div>
    <div style="font-size:18px;color:#ffd98a;margin-bottom:6px;font-weight:700;">Closed beta</div>
    <div style="font-size:15px;color:#bad3a3;max-width:420px;line-height:1.5;">
      This build is locked to an invited beta cohort. If you have an
      invite link, open it now and the gate will remember you.
    </div>
    <div style="margin-top:22px;font-size:13px;color:#8ea383;">
      Public launch: coming soon.
    </div>
  `;
  document.body.appendChild(el);
}
