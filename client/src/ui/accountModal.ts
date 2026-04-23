import type { AuthClient } from '../net/Auth.js';

// Username/password login + register overlay. Vanilla DOM (not Phaser)
// because it needs real text inputs — Phaser's native input support
// is awkward at best, and a DOM form layers cleanly over the canvas.
// The styles live here too to avoid a second CSS file for ~30 lines.
//
// Flow:
//   - Opens on user command ("Account" button) or on first boot when
//     the caller decides to nudge the guest.
//   - Two tabs: Register (claim the current guest) and Log in
//     (swap to an existing account on this device).
//   - onSuccess fires after either path; callers typically reload
//     runtime.player via /player/me and refresh the HUD.

export interface AccountModalOptions {
  auth: AuthClient;
  mode?: 'register' | 'login';
  onSuccess: () => void;
  onClose?: () => void;
}

const STYLE_ID = 'hive-account-modal-style';
const CSS = `
.hive-account-overlay {
  position: fixed; inset: 0;
  background: rgba(10, 18, 12, 0.78);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.hive-account-card {
  width: min(420px, 92vw);
  background: linear-gradient(180deg, #243824 0%, #1b2c1c 35%, #0f1b10 100%);
  color: #e6f5d2;
  border: 3px solid #5c4020;
  border-radius: 14px;
  padding: 20px 24px;
  box-shadow:
    inset 0 2px 0 rgba(255, 217, 138, 0.45),
    0 18px 48px rgba(0, 0, 0, 0.6);
}
.hive-account-card h2 {
  margin: 0 0 8px;
  font-size: 22px;
  color: #ffe7b0;
  letter-spacing: 0.5px;
  font-weight: 700;
  text-shadow:
    -1px -1px 0 #0a120c,
    1px -1px 0 #0a120c,
    -1px 1px 0 #0a120c,
    1px 1px 0 #0a120c,
    0 3px 5px rgba(0, 0, 0, 0.6);
}
.hive-account-card p.hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: #b8d3a4;
  line-height: 1.5;
}
.hive-account-tabs {
  display: flex; gap: 4px;
  margin-bottom: 14px;
  border-bottom: 1px solid #2a4a1f;
}
.hive-account-tab {
  flex: 1;
  background: none;
  border: none;
  padding: 8px 0;
  color: #a6c48e;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.hive-account-tab.active {
  color: #ffd98a;
  border-bottom-color: #ffd98a;
}
.hive-account-card label {
  display: block;
  margin: 8px 0 4px;
  font-size: 11px;
  color: #b8d3a4;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.hive-account-card input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  background: #0f1b10;
  color: #e6f5d2;
  border: 1px solid #2a4a1f;
  border-radius: 8px;
  font-family: inherit;
  font-size: 14px;
}
.hive-account-card input:focus {
  outline: none;
  border-color: #ffd98a;
}
.hive-account-actions {
  display: flex; gap: 8px; justify-content: space-between;
  margin-top: 16px;
}
.hive-account-btn {
  background: #ffd98a;
  color: #0f1b10;
  border: none;
  border-radius: 8px;
  padding: 10px 18px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.hive-account-btn:disabled { opacity: 0.6; cursor: wait; }
.hive-account-btn.ghost {
  background: transparent;
  color: #c3e8b0;
  border: 1px solid #2a4a1f;
}
.hive-account-btn .hive-spinner {
  display: inline-block;
  width: 12px; height: 12px;
  margin-right: 6px;
  vertical-align: -2px;
  border: 2px solid rgba(15, 27, 16, 0.25);
  border-top-color: #0f1b10;
  border-radius: 50%;
  animation: hive-spin 0.6s linear infinite;
}
@keyframes hive-spin { to { transform: rotate(360deg); } }
.hive-account-error {
  margin-top: 10px;
  font-size: 12px;
  color: #ffb0a0;
  min-height: 16px;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.append(el);
}

export function openAccountModal(opts: AccountModalOptions): () => void {
  ensureStyle();
  let mode: 'register' | 'login' = opts.mode ?? 'register';
  const overlay = document.createElement('div');
  overlay.className = 'hive-account-overlay';
  overlay.innerHTML = `
    <form class="hive-account-card" autocomplete="off">
      <h2>Hive Wars · Account</h2>
      <div class="hive-account-tabs">
        <button type="button" class="hive-account-tab" data-tab="register">Register</button>
        <button type="button" class="hive-account-tab" data-tab="login">Log in</button>
      </div>
      <p class="hint">Register to save your colony to the cloud — log in on any device to pick up where you left off.</p>
      <label for="hive-username">Username</label>
      <input id="hive-username" name="username" type="text" autocomplete="username" minlength="3" maxlength="20" required />
      <label for="hive-password">Password</label>
      <input id="hive-password" name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required />
      <div class="hive-account-actions">
        <button type="button" class="hive-account-btn ghost" data-act="cancel">Stay as guest</button>
        <button type="submit" class="hive-account-btn" data-act="submit">Register</button>
      </div>
      <div class="hive-account-error" role="alert"></div>
    </form>
  `;
  document.body.append(overlay);

  const form = overlay.querySelector('form') as HTMLFormElement;
  const submit = form.querySelector('[data-act="submit"]') as HTMLButtonElement;
  const errEl = form.querySelector('.hive-account-error') as HTMLDivElement;
  const tabs = overlay.querySelectorAll<HTMLButtonElement>('.hive-account-tab');
  const pwInput = form.querySelector<HTMLInputElement>('#hive-password')!;

  function setMode(next: 'register' | 'login'): void {
    mode = next;
    tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
    submit.textContent = mode === 'register' ? 'Register' : 'Log in';
    pwInput.setAttribute(
      'autocomplete',
      mode === 'register' ? 'new-password' : 'current-password',
    );
    errEl.textContent = '';
  }
  tabs.forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.tab as 'register' | 'login')),
  );
  setMode(mode);

  const close = (): void => {
    overlay.remove();
    opts.onClose?.();
  };
  form.querySelector('[data-act="cancel"]')?.addEventListener('click', close);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (form.elements.namedItem('username') as HTMLInputElement).value.trim();
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;
    submit.disabled = true;
    const priorLabel = submit.textContent ?? '';
    submit.innerHTML = `<span class="hive-spinner" aria-hidden="true"></span>${mode === 'register' ? 'Registering…' : 'Logging in…'}`;
    errEl.textContent = '';
    try {
      if (mode === 'register') {
        await opts.auth.register(username, password);
      } else {
        await opts.auth.login(username, password);
      }
      overlay.remove();
      opts.onSuccess();
    } catch (err) {
      errEl.textContent = (err as Error).message || 'Something went wrong';
      submit.textContent = priorLabel;
      submit.disabled = false;
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return close;
}
