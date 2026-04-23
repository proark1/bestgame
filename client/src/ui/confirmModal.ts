// Shared in-game confirm dialog. Replaces the browser-native
// window.confirm() / window.alert() used for destructive actions
// (leave clan, destructive raid choices) so every branching moment
// uses the same dark-glass visual language as the account + clan
// modals. Vanilla DOM, same pattern as accountModal / clanCreateModal
// — overlay + card, focus lands on the confirm button.
//
// Returns a Promise<boolean>: true if the user confirms, false if
// they cancel or dismiss via backdrop click / Escape.

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // When true, the confirm button paints red — for destructive
  // actions the user shouldn't accidentally trigger.
  danger?: boolean;
}

const STYLE_ID = 'hive-confirm-modal-style';
const CSS = `
.hive-confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(10, 18, 12, 0.78);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.hive-confirm-card {
  width: min(380px, 92vw);
  background: linear-gradient(180deg, #243824 0%, #1b2c1c 35%, #0f1b10 100%);
  color: #e6f5d2;
  border: 3px solid #5c4020;
  border-radius: 14px;
  padding: 20px 22px 16px;
  box-shadow:
    inset 0 2px 0 rgba(255, 217, 138, 0.45),
    0 18px 48px rgba(0, 0, 0, 0.6);
}
.hive-confirm-card h2 {
  margin: 0 0 8px;
  font-size: 19px;
  color: #ffe7b0;
  font-weight: 700;
  text-shadow:
    -1px -1px 0 #0a120c,
    1px -1px 0 #0a120c,
    -1px 1px 0 #0a120c,
    1px 1px 0 #0a120c,
    0 3px 5px rgba(0, 0, 0, 0.6);
}
.hive-confirm-card p {
  margin: 0 0 14px;
  font-size: 13px;
  color: #b8d3a4;
  line-height: 1.5;
}
.hive-confirm-actions {
  display: flex; gap: 10px; justify-content: flex-end;
  margin-top: 4px;
}
.hive-confirm-btn {
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
.hive-confirm-btn.ghost {
  background: transparent;
  color: #c3e8b0;
  border: 1px solid #2a4a1f;
}
.hive-confirm-btn.danger {
  background: #d94c4c;
  color: #fff2d2;
}
.hive-confirm-btn:focus-visible {
  outline: 2px solid #ffd98a;
  outline-offset: 2px;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.append(el);
}

export function openConfirm(opts: ConfirmOptions): Promise<boolean> {
  ensureStyle();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'hive-confirm-overlay';
    const confirmClass = opts.danger ? 'hive-confirm-btn danger' : 'hive-confirm-btn';
    overlay.innerHTML = `
      <div class="hive-confirm-card" role="alertdialog" aria-modal="true">
        <h2></h2>
        <p></p>
        <div class="hive-confirm-actions">
          <button type="button" class="hive-confirm-btn ghost" data-act="cancel"></button>
          <button type="button" class="${confirmClass}" data-act="confirm"></button>
        </div>
      </div>
    `;
    // textContent assignments keep user-supplied strings escaped
    // (overlay.innerHTML above uses only trusted static markup).
    const titleEl = overlay.querySelector('h2') as HTMLHeadingElement;
    const bodyEl = overlay.querySelector('p') as HTMLParagraphElement;
    const confirmBtn = overlay.querySelector('[data-act="confirm"]') as HTMLButtonElement;
    const cancelBtn = overlay.querySelector('[data-act="cancel"]') as HTMLButtonElement;
    titleEl.textContent = opts.title;
    bodyEl.textContent = opts.body ?? '';
    if (!opts.body) bodyEl.style.display = 'none';
    confirmBtn.textContent = opts.confirmLabel ?? 'Confirm';
    cancelBtn.textContent = opts.cancelLabel ?? 'Cancel';

    const close = (value: boolean): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    document.addEventListener('keydown', onKey);
    confirmBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });

    document.body.append(overlay);
    // Default focus on the non-destructive option so a user mashing
    // Enter on a leave-clan confirm doesn't accidentally leave.
    (opts.danger ? cancelBtn : confirmBtn).focus();
  });
}

// Convenience wrapper mirroring window.alert — single OK button,
// resolves when dismissed. Used for post-action error banners so we
// don't split visual language between native alert() and our modal.
export function openAlert(title: string, body?: string): Promise<void> {
  const opts: ConfirmOptions = {
    title,
    confirmLabel: 'OK',
    cancelLabel: 'OK',
  };
  if (body !== undefined) opts.body = body;
  return openConfirm(opts).then(() => undefined);
}
