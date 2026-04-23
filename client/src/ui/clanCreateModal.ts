// Clan-create overlay. Same DOM-layer pattern as the account +
// tutorial modals so the three dialogs feel consistent (same font,
// same dark glass card, same close-on-outside-click).
//
// Three inputs: name (2-32 chars), tag (2-5 A-Z0-9), description.
// Validation is inline — submit button disables + red subtext
// surfaces any rule violation rather than blocking at the fetch.

export interface ClanCreateValues {
  name: string;
  tag: string;
  description: string;
  isOpen: boolean;
}

const STYLE_ID = 'hive-clan-modal-style';
const CSS = `
.hive-clan-overlay {
  position: fixed; inset: 0;
  background: rgba(10, 18, 12, 0.82);
  backdrop-filter: blur(5px);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.hive-clan-card {
  width: min(440px, 92vw);
  background: linear-gradient(180deg, #243824 0%, #1b2c1c 35%, #0f1b10 100%);
  color: #e6f5d2;
  border: 3px solid #5c4020;
  border-radius: 14px;
  padding: 22px 26px 18px;
  box-shadow:
    inset 0 2px 0 rgba(255, 217, 138, 0.45),
    0 18px 48px rgba(0, 0, 0, 0.6);
}
.hive-clan-card h2 {
  margin: 0 0 6px;
  font-size: 22px;
  color: #ffe7b0;
  font-weight: 700;
  text-shadow:
    -1px -1px 0 #0a120c,
    1px -1px 0 #0a120c,
    -1px 1px 0 #0a120c,
    1px 1px 0 #0a120c,
    0 3px 5px rgba(0, 0, 0, 0.6);
}
.hive-clan-card .sub {
  margin: 0 0 14px;
  font-size: 12px;
  color: #b8d3a4;
}
.hive-clan-card label {
  display: block;
  margin: 10px 0 4px;
  font-size: 11px;
  color: #b8d3a4;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.hive-clan-card input, .hive-clan-card textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  background: #0f1b10;
  color: #e6f5d2;
  border: 1px solid #2a4a1f;
  border-radius: 8px;
  font-family: inherit;
  font-size: 14px;
  resize: vertical;
}
.hive-clan-card input:focus, .hive-clan-card textarea:focus {
  outline: none;
  border-color: #ffd98a;
}
.hive-clan-checkbox {
  display: flex; align-items: center; gap: 8px;
  margin-top: 12px;
  font-size: 12px;
  color: #c3e8b0;
}
.hive-clan-actions {
  display: flex; gap: 10px; justify-content: space-between;
  margin-top: 18px;
}
.hive-clan-btn {
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
.hive-clan-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.hive-clan-btn.ghost {
  background: transparent;
  color: #c3e8b0;
  border: 1px solid #2a4a1f;
}
.hive-clan-btn .hive-spinner {
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
.hive-clan-error {
  margin-top: 8px;
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

const NAME_RE = /^.{2,32}$/;
const TAG_RE = /^[A-Z0-9]{2,5}$/;

export function openClanCreateModal(opts: {
  onSubmit: (values: ClanCreateValues) => Promise<void>;
  onClose?: () => void;
}): () => void {
  ensureStyle();
  const overlay = document.createElement('div');
  overlay.className = 'hive-clan-overlay';
  overlay.innerHTML = `
    <form class="hive-clan-card" autocomplete="off">
      <h2>Create a clan</h2>
      <p class="sub">Clans chat in-game and can coordinate raids. You'll be the first member + leader.</p>
      <label for="hive-clan-name">Name</label>
      <input id="hive-clan-name" name="name" type="text" minlength="2" maxlength="32" required placeholder="Mossy Mandibles" />
      <label for="hive-clan-tag">Tag</label>
      <input id="hive-clan-tag" name="tag" type="text" minlength="2" maxlength="5" required placeholder="HIVE" style="text-transform: uppercase" />
      <label for="hive-clan-desc">Description</label>
      <textarea id="hive-clan-desc" name="description" rows="3" maxlength="280" placeholder="What kind of ants are you?"></textarea>
      <label class="hive-clan-checkbox">
        <input type="checkbox" name="isOpen" checked />
        <span>Anyone can join (uncheck to make the clan invite-only)</span>
      </label>
      <div class="hive-clan-actions">
        <button type="button" class="hive-clan-btn ghost" data-act="cancel">Cancel</button>
        <button type="submit" class="hive-clan-btn" data-act="submit">Create</button>
      </div>
      <div class="hive-clan-error" role="alert"></div>
    </form>
  `;
  document.body.append(overlay);

  const form = overlay.querySelector('form') as HTMLFormElement;
  const submit = form.querySelector('[data-act="submit"]') as HTMLButtonElement;
  const errEl = form.querySelector('.hive-clan-error') as HTMLDivElement;

  const close = (): void => {
    overlay.remove();
    opts.onClose?.();
  };
  form.querySelector('[data-act="cancel"]')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    const tag = (form.elements.namedItem('tag') as HTMLInputElement).value
      .trim()
      .toUpperCase();
    const description = (form.elements.namedItem('description') as HTMLTextAreaElement).value.trim();
    const isOpen = (form.elements.namedItem('isOpen') as HTMLInputElement).checked;
    if (!NAME_RE.test(name)) {
      errEl.textContent = 'Name must be 2-32 characters.';
      return;
    }
    if (!TAG_RE.test(tag)) {
      errEl.textContent = 'Tag must be 2-5 uppercase letters or digits (A-Z, 0-9).';
      return;
    }
    submit.disabled = true;
    const priorLabel = submit.textContent ?? '';
    submit.innerHTML = `<span class="hive-spinner" aria-hidden="true"></span>Creating…`;
    errEl.textContent = '';
    try {
      await opts.onSubmit({ name, tag, description, isOpen });
      overlay.remove();
    } catch (err) {
      errEl.textContent = (err as Error).message || 'Create failed';
      submit.textContent = priorLabel;
      submit.disabled = false;
    }
  });

  return close;
}
