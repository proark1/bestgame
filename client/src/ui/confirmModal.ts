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
  // Single-button mode — used by openAlert. The cancel button is
  // removed from the DOM (not just hidden) so layout collapses to a
  // single OK affordance; Escape / backdrop-click still dismiss.
  hideCancel?: boolean;
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
.hive-slide-track {
  position: relative;
  height: 44px;
  background: linear-gradient(180deg, #1a2a1a 0%, #0e1810 100%);
  border: 1px solid #2a4a1f;
  border-radius: 22px;
  overflow: hidden;
  user-select: none;
  margin-top: 6px;
}
.hive-slide-fill {
  position: absolute; inset: 0 auto 0 0;
  background: linear-gradient(180deg, #d94c4c 0%, #952d2d 100%);
  width: 0;
  border-radius: 22px;
  transition: width 0.18s ease-out;
}
.hive-slide-track.armed .hive-slide-fill {
  background: linear-gradient(180deg, #ffd98a 0%, #d4af37 100%);
}
.hive-slide-label {
  position: relative; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  height: 100%;
  font-weight: 700; font-size: 13px;
  color: #fff2d2;
  letter-spacing: 0.04em;
  pointer-events: none;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.hive-slide-thumb {
  position: absolute; top: 4px; left: 4px;
  width: 36px; height: 36px;
  background: linear-gradient(180deg, #fff2d2 0%, #d4af37 100%);
  border-radius: 50%;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
  cursor: grab;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; color: #0f1b10;
  z-index: 2;
}
.hive-slide-thumb:active { cursor: grabbing; }
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
    if (opts.hideCancel) cancelBtn.remove();

    const close = (value: boolean): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    // Escape dismisses (Enter is intentionally NOT handled here —
    // browsers already fire a click on the focused button for Enter,
    // so forcing `close(true)` here would override the danger-mode
    // "focus cancel" safety and silently confirm a leave-clan).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false);
    };
    document.addEventListener('keydown', onKey);
    confirmBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });

    document.body.append(overlay);
    // Default focus: confirm for ordinary + alert dialogs, cancel for
    // destructive ones so a user mashing Enter on a leave-clan confirm
    // doesn't accidentally leave.
    (opts.danger && !opts.hideCancel ? cancelBtn : confirmBtn).focus();
  });
}

// Convenience wrapper mirroring window.alert — single OK button,
// resolves when dismissed. Used for post-action error banners so we
// don't split visual language between native alert() and our modal.
export function openAlert(title: string, body?: string): Promise<void> {
  const opts: ConfirmOptions = {
    title,
    confirmLabel: 'OK',
    hideCancel: true,
  };
  if (body !== undefined) opts.body = body;
  return openConfirm(opts).then(() => undefined);
}

export interface SlideConfirmOptions {
  title: string;
  body?: string;
  // Label rendered inside the slider track. Defaults to "→ slide to
  // confirm". Keep short — track is ~340px wide.
  slideLabel?: string;
  cancelLabel?: string;
}

// Slide-to-confirm — a heavier confirmation gesture for actions a
// single tap shouldn't be able to fire (demolish, log out, surrender,
// "leave clan with all my donations", etc.). Resolves true once the
// user drags the thumb past 90% of the track width; false on cancel,
// Escape, or backdrop click. Touch + mouse + keyboard handled.
export function openSlideConfirm(opts: SlideConfirmOptions): Promise<boolean> {
  ensureStyle();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'hive-confirm-overlay';
    overlay.innerHTML = `
      <div class="hive-confirm-card" role="alertdialog" aria-modal="true">
        <h2></h2>
        <p></p>
        <div class="hive-slide-track" role="slider" aria-label="Slide to confirm" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="hive-slide-fill"></div>
          <div class="hive-slide-label"></div>
          <div class="hive-slide-thumb" aria-hidden="true">→</div>
        </div>
        <div class="hive-confirm-actions">
          <button type="button" class="hive-confirm-btn ghost" data-act="cancel"></button>
        </div>
      </div>
    `;
    const titleEl = overlay.querySelector('h2') as HTMLHeadingElement;
    const bodyEl = overlay.querySelector('p') as HTMLParagraphElement;
    const track = overlay.querySelector('.hive-slide-track') as HTMLDivElement;
    const fill = overlay.querySelector('.hive-slide-fill') as HTMLDivElement;
    const labelEl = overlay.querySelector('.hive-slide-label') as HTMLDivElement;
    const thumb = overlay.querySelector('.hive-slide-thumb') as HTMLDivElement;
    const cancelBtn = overlay.querySelector('[data-act="cancel"]') as HTMLButtonElement;
    titleEl.textContent = opts.title;
    bodyEl.textContent = opts.body ?? '';
    if (!opts.body) bodyEl.style.display = 'none';
    labelEl.textContent = opts.slideLabel ?? '→ slide to confirm';
    cancelBtn.textContent = opts.cancelLabel ?? 'Cancel';

    const THRESHOLD = 0.9;
    let pointerId: number | null = null;
    let startX = 0;
    let progress = 0;

    const setProgress = (p: number): void => {
      progress = Math.max(0, Math.min(1, p));
      const trackW = track.clientWidth;
      const thumbW = thumb.clientWidth;
      const travel = trackW - thumbW - 8;
      thumb.style.left = `${4 + travel * progress}px`;
      fill.style.width = `${4 + (thumbW + travel * progress)}px`;
      track.classList.toggle('armed', progress >= THRESHOLD);
      track.setAttribute('aria-valuenow', `${Math.round(progress * 100)}`);
    };

    const close = (value: boolean): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false);
      if (document.activeElement === track) {
        if (e.key === 'ArrowRight' || e.key === 'End') {
          e.preventDefault();
          setProgress(e.key === 'End' ? 1 : progress + 0.1);
          if (progress >= THRESHOLD) close(true);
        } else if (e.key === 'ArrowLeft' || e.key === 'Home') {
          e.preventDefault();
          setProgress(e.key === 'Home' ? 0 : progress - 0.1);
        } else if (e.key === 'Enter' && progress >= THRESHOLD) {
          close(true);
        }
      }
    };
    document.addEventListener('keydown', onKey);

    const onPointerDown = (e: PointerEvent): void => {
      e.preventDefault();
      pointerId = e.pointerId;
      thumb.setPointerCapture(pointerId);
      startX = e.clientX - progress * (track.clientWidth - thumb.clientWidth - 8);
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (pointerId !== e.pointerId) return;
      const travel = track.clientWidth - thumb.clientWidth - 8;
      setProgress((e.clientX - startX) / Math.max(1, travel));
    };
    const onPointerUp = (e: PointerEvent): void => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      if (progress >= THRESHOLD) {
        setProgress(1);
        close(true);
      } else {
        // Snap back when the user releases short of the threshold.
        setProgress(0);
      }
    };
    thumb.addEventListener('pointerdown', onPointerDown);
    thumb.addEventListener('pointermove', onPointerMove);
    thumb.addEventListener('pointerup', onPointerUp);
    thumb.addEventListener('pointercancel', onPointerUp);

    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });

    document.body.append(overlay);
    track.focus();
  });
}
