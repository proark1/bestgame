// A single sprite card in the admin grid. Encapsulates its own local
// state (prompt text, candidate list, selected index, compression)
// and exposes helpers for the parent app to drive "generate all"
// and bulk operations.

import { compressBase64Image, humanBytes, type CompressedImage } from './compress.js';
import {
  deleteSprite,
  fetchSpriteHistory,
  generateImages,
  loadSpriteHistoryBytes,
  restoreSpriteHistory,
  saveSprite,
  type GeminiImage,
  type SpriteHistoryEntry,
} from './api.js';
import { removeBackground, removeNearWhite } from './removeBackground.js';

export interface SpriteCardOptions {
  key: string;
  initialPrompt: string;
  fileMeta: { exists: boolean; size: number; ext: 'png' | 'webp' | null };
  // Compose the full prompt (styleLock + description). Controlled by parent.
  composePrompt: (rawDescription: string) => string;
  getCompression: () => { format: 'webp' | 'png'; quality: number; maxDim: number };
  onPromptSave: (newValue: string) => Promise<void>;
  onSaved: (result: { path: string; ext: 'png' | 'webp' }) => void;
  showStatus: (msg: string, kind?: 'info' | 'error' | 'success') => void;
}

export class SpriteCard {
  readonly key: string;
  readonly root: HTMLDivElement;
  private rawPrompt: string;
  private candidates: GeminiImage[] = [];
  private compressed: CompressedImage | null = null;
  private selectedIdx = -1;
  private busy = false;
  private readonly opts: SpriteCardOptions;
  private cardCompression: { format: 'webp' | 'png'; quality: number; maxDim: number } | null = null;

  private thumbEl!: HTMLDivElement;
  private metaEl!: HTMLSpanElement;
  private candidatesEl!: HTMLDivElement;
  private promptEl!: HTMLTextAreaElement;
  // Optional free-text label attached to the next save. Consumed by
  // the server to tag the history row so the admin can find a
  // generation by intent ("warmer colors") instead of timestamp.
  private labelEl?: HTMLInputElement;
  private generateBtn!: HTMLButtonElement;
  private removeBgBtn!: HTMLButtonElement;
  private removeGraysBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private downloadBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private variantsSelect!: HTMLSelectElement;
  private compressionPanel?: HTMLDivElement;
  private compressionToggle?: HTMLButtonElement;

  constructor(opts: SpriteCardOptions) {
    this.key = opts.key;
    this.opts = opts;
    this.rawPrompt = opts.initialPrompt;
    this.root = document.createElement('div');
    this.root.className = 'card';
    this.render();
  }

  destroy(): void {
    this.root.remove();
  }

  // Full automation entry point: generate one candidate, compress it,
  // save it — without waiting for a human to pick. Used by the toolbar's
  // "Automate all missing" button.
  async automate(): Promise<boolean> {
    if (this.busy) return false;
    this.setBusy(true);
    try {
      const fullPrompt = this.opts.composePrompt(this.rawPrompt);
      const imgs = await generateImages({ prompt: fullPrompt, variants: 1 });
      if (imgs.length === 0) throw new Error('no image returned');
      this.candidates = imgs;
      this.selectedIdx = 0;
      this.renderCandidates();
      await this.prepareCompressed();
    } catch (err) {
      this.opts.showStatus(`${this.key}: ${(err as Error).message}`, 'error');
      this.setBusy(false);
      return false;
    }
    this.setBusy(false); // unlock before save() re-locks
    await this.save();
    return !!this.compressed;
  }

  // Public — the toolbar "Generate all missing" button uses this.
  async generate(): Promise<void> {
    if (this.busy) return;
    const variants = Number(this.variantsSelect.value) || 1;
    this.setBusy(true);
    this.opts.showStatus(`Generating ${this.key}…`);
    try {
      const fullPrompt = this.opts.composePrompt(this.rawPrompt);
      const imgs = await generateImages({ prompt: fullPrompt, variants });
      this.candidates = imgs;
      this.selectedIdx = 0;
      this.renderCandidates();
      await this.prepareCompressed();
      this.opts.showStatus(`Got ${imgs.length} candidate(s) for ${this.key}`, 'success');
    } catch (err) {
      this.opts.showStatus(`${this.key}: ${(err as Error).message}`, 'error');
    } finally {
      this.setBusy(false);
    }
  }

  async save(): Promise<void> {
    if (this.busy || this.selectedIdx < 0) return;
    await this.prepareCompressed();
    if (!this.compressed) return;
    this.setBusy(true);
    const ext = this.opts.getCompression().format;
    // Read the current label input so the new history row carries
    // it. Empty = no label, which is fine — server stores null.
    const label = this.labelEl?.value.trim() ?? '';
    try {
      const res = await saveSprite({
        key: this.key,
        data: this.compressed.base64,
        format: ext,
        ...(label.length > 0 ? { label } : {}),
      });
      this.opts.onSaved({ path: res.path, ext });
      this.opts.showStatus(`Saved ${this.key} (${humanBytes(res.size)})`, 'success');
      // refresh thumb from saved path
      this.refreshThumb(res.path);
      // Clear the label field so the next save starts fresh — the
      // label is tied to THIS generation, not sticky for the card.
      if (this.labelEl) this.labelEl.value = '';
    } catch (err) {
      this.opts.showStatus(`save failed: ${(err as Error).message}`, 'error');
    } finally {
      this.setBusy(false);
    }
  }

  // Open the history modal for this key. Shows the last N generations
  // (metadata from /admin/api/sprite/:key/history, bytes streamed one
  // per entry) with a "Use this" button that calls restore.
  async openHistory(): Promise<void> {
    let resp;
    try {
      resp = await fetchSpriteHistory(this.key);
    } catch (err) {
      this.opts.showStatus(
        `history load failed: ${(err as Error).message}`,
        'error',
      );
      return;
    }
    if (resp.dbPersistence === 'not-configured') {
      this.opts.showStatus(
        'History is DB-backed — set DATABASE_URL to enable.',
        'error',
      );
      return;
    }
    if (resp.entries.length === 0) {
      this.opts.showStatus(
        `No history yet for ${this.key}. Save at least once to start tracking.`,
        'info',
      );
      return;
    }
    this.renderHistoryModal(resp.entries);
  }

  private renderHistoryModal(entries: SpriteHistoryEntry[]): void {
    // Overlay + card. Vanilla DOM — same pattern the other admin
    // modals use (no Phaser, CSS only). Click outside card to dismiss.
    const overlay = document.createElement('div');
    overlay.className = 'history-overlay';
    const card = document.createElement('div');
    card.className = 'history-card';
    const h = document.createElement('h2');
    h.textContent = `${this.key} · history`;
    const sub = document.createElement('p');
    sub.className = 'history-sub';
    sub.textContent =
      'Last generations kept for this key. Pick one and click ' +
      '"Use this" to promote it to the live bytes the game renders. ' +
      'The restored version is appended to the top of history, so ' +
      'you can flip back to whichever generation was live before.';
    card.append(h, sub);

    const grid = document.createElement('div');
    grid.className = 'history-grid';
    card.append(grid);

    // Track object URLs so we can revoke them when the modal closes
    // — a preview is a few hundred KB and leaking three per open
    // adds up quickly if the admin hops between cards.
    const urlBag: string[] = [];

    const close = (): void => {
      for (const u of urlBag) URL.revokeObjectURL(u);
      overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // First entry is the currently-live one (most recent). Mark it
    // so the admin sees which is current.
    entries.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'history-entry';
      if (i === 0) row.classList.add('active');

      const thumbBox = document.createElement('div');
      thumbBox.className = 'history-thumb';
      // Loading placeholder, replaced when the bytes arrive.
      thumbBox.textContent = '…';
      row.append(thumbBox);

      void loadSpriteHistoryBytes(this.key, entry.id)
        .then((url) => {
          urlBag.push(url);
          thumbBox.textContent = '';
          const img = document.createElement('img');
          img.src = url;
          thumbBox.append(img);
        })
        .catch((err: unknown) => {
          thumbBox.textContent = '(preview failed)';
          // eslint-disable-next-line no-console
          console.warn('history preview failed', err);
        });

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const when = new Date(entry.createdAt);
      const stamp = when.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const stampEl = document.createElement('div');
      stampEl.className = 'history-stamp';
      stampEl.textContent = stamp + (i === 0 ? ' · LIVE' : '');
      meta.append(stampEl);
      if (entry.label) {
        const labelEl = document.createElement('div');
        labelEl.className = 'history-label';
        labelEl.textContent = entry.label;
        meta.append(labelEl);
      }
      const sizeEl = document.createElement('div');
      sizeEl.className = 'history-size';
      sizeEl.textContent = `${entry.format.toUpperCase()} · ${humanBytes(entry.size)}${
        entry.frames > 1 ? ` · ${entry.frames} frames` : ''
      }`;
      meta.append(sizeEl);
      row.append(meta);

      const actions = document.createElement('div');
      actions.className = 'history-actions';
      if (i === 0) {
        const liveTag = document.createElement('span');
        liveTag.className = 'history-live-tag';
        liveTag.textContent = 'currently live';
        actions.append(liveTag);
      } else {
        const useBtn = document.createElement('button');
        useBtn.className = 'btn primary';
        useBtn.textContent = 'Use this';
        useBtn.addEventListener('click', async () => {
          useBtn.disabled = true;
          useBtn.textContent = '…';
          try {
            await restoreSpriteHistory(this.key, entry.id);
            const ext = entry.format;
            this.opts.onSaved({
              path: `/assets/sprites/${this.key}.${ext}`,
              ext,
            });
            this.opts.showStatus(
              `Restored ${this.key} from ${stamp}`,
              'success',
            );
            this.refreshThumb(`/assets/sprites/${this.key}.${ext}`);
            close();
          } catch (err) {
            this.opts.showStatus(
              `restore failed: ${(err as Error).message}`,
              'error',
            );
            useBtn.disabled = false;
            useBtn.textContent = 'Use this';
          }
        });
        actions.append(useBtn);
      }
      row.append(actions);
      grid.append(row);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn ghost';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', close);
    card.append(closeBtn);

    overlay.append(card);
    document.body.append(overlay);
  }

  async download(): Promise<void> {
    await this.prepareCompressed();
    if (!this.compressed) return;
    const { base64, mimeType } = this.compressed;
    const ext = mimeType === 'image/webp' ? 'webp' : 'png';
    const bytes = base64ToUint8Array(base64);
    // Use the underlying ArrayBuffer slice so Blob's type-check is happy
    // (TS narrows Uint8Array<ArrayBufferLike>; we want ArrayBuffer).
    const blob = new Blob(
      [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
      { type: mimeType },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.key}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async delete(): Promise<void> {
    if (!confirm(`Delete saved image for ${this.key}?`)) return;
    try {
      await deleteSprite(this.key);
      this.opts.showStatus(`Deleted ${this.key}`);
      this.refreshThumb(null);
    } catch (err) {
      this.opts.showStatus(`${(err as Error).message}`, 'error');
    }
  }

  private render(): void {
    this.root.innerHTML = '';

    const head = el('div', 'card-head');
    const title = el('span', 'card-title');
    title.textContent = this.key;
    const meta = el('span', 'card-meta');
    const m = this.opts.fileMeta;
    meta.textContent = m.exists
      ? `${(m.ext ?? '').toUpperCase()} · ${humanBytes(m.size)}`
      : 'placeholder';
    meta.classList.add(m.exists ? 'ok' : 'warn');
    this.metaEl = meta;
    head.append(title, meta);

    this.thumbEl = el('div', 'thumb');
    if (m.exists) {
      const img = document.createElement('img');
      // cache-bust so re-saves are visible immediately
      img.src = `/assets/sprites/${this.key}.${m.ext}?t=${m.size}`;
      this.thumbEl.append(img);
    } else {
      this.thumbEl.classList.add('empty');
      this.thumbEl.textContent = 'no image yet';
    }

    this.candidatesEl = el('div', 'candidates');

    this.promptEl = document.createElement('textarea');
    this.promptEl.className = 'prompt';
    this.promptEl.value = this.rawPrompt;
    this.promptEl.placeholder = 'describe the subject…';
    this.promptEl.addEventListener('change', async () => {
      this.rawPrompt = this.promptEl.value;
      try {
        await this.opts.onPromptSave(this.rawPrompt);
        this.opts.showStatus(`Prompt saved for ${this.key}`, 'success');
      } catch (err) {
        this.opts.showStatus(`prompt save failed: ${(err as Error).message}`, 'error');
      }
    });

    const variantRow = el('div', 'stat-row');
    const variantsLabel = el('span');
    variantsLabel.textContent = 'variants';
    this.variantsSelect = document.createElement('select');
    for (const v of [1, 2, 4]) {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = `${v}×`;
      this.variantsSelect.append(opt);
    }
    variantRow.append(variantsLabel, this.variantsSelect);

    // Optional label that tags the next save's history row so the
    // admin can pick a generation by intent later. Kept compact
    // (single-line input) so it doesn't steal vertical space from
    // the thumbnails that actually need it.
    const labelRow = el('div', 'stat-row');
    const labelCaption = el('span');
    labelCaption.textContent = 'label';
    this.labelEl = document.createElement('input');
    this.labelEl.type = 'text';
    this.labelEl.className = 'history-label-input';
    this.labelEl.maxLength = 120;
    this.labelEl.placeholder = 'optional — e.g. "warmer colors"';
    labelRow.append(labelCaption, this.labelEl);

    const actions = el('div', 'card-actions');
    this.generateBtn = button('Generate', 'btn accent', () => void this.generate());
    this.removeBgBtn = button('Remove BG', 'btn', () => void this.removeBackground());
    // Second-stage cleanup. "Remove BG" clears the dominant backdrop
    // colour; "Remove grays" clears any low-chroma / near-white haze
    // that's connected (directly or via already-transparent pixels)
    // to the outside. Interior whites (eye gems, metal highlights)
    // are preserved because the flood never enters an isolated
    // subject-interior region.
    this.removeGraysBtn = button('Remove grays', 'btn', () =>
      void this.removeNearWhite(),
    );
    this.saveBtn = button('Save', 'btn primary', () => void this.save());
    this.downloadBtn = button('Download', 'btn', () => void this.download());
    this.historyBtn = button('History', 'btn', () => void this.openHistory());
    const delBtn = button('Delete', 'btn ghost danger', () => void this.delete());
    this.removeBgBtn.disabled = true;
    this.removeGraysBtn.disabled = true;
    this.saveBtn.disabled = true;
    this.downloadBtn.disabled = true;
    // History is enabled whenever the sprite exists on disk (or has
    // ever been saved) — it hits the DB and has nothing to do with
    // candidate selection.
    this.historyBtn.disabled = !this.opts.fileMeta.exists;
    actions.append(
      this.generateBtn,
      this.removeBgBtn,
      this.removeGraysBtn,
      this.saveBtn,
      this.downloadBtn,
      this.historyBtn,
      delBtn,
    );

    this.root.append(
      head,
      this.thumbEl,
      this.candidatesEl,
      this.promptEl,
      variantRow,
      labelRow,
      actions,
    );

    // Compression panel (collapsed by default, toggle to expand)
    this.renderCompressionPanel();
  }

  private renderCompressionPanel(): void {
    this.compressionToggle?.remove();
    this.compressionPanel?.remove();

    const panel = el('div', 'compression-panel');
    panel.hidden = true;

    const toggle = document.createElement('button');
    toggle.className = 'btn ghost compress-toggle';
    toggle.textContent = 'Compression ▼';
    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      toggle.textContent = panel.hidden ? 'Compression ▼' : 'Compression ▲';
    });

    const content = el('div', 'compression-content');

    // Format selector
    const fmtLabel = el('label');
    fmtLabel.innerHTML = `<span>format</span>`;
    const fmtSel = document.createElement('select');
    for (const f of ['webp', 'png']) {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f.toUpperCase();
      fmtSel.append(opt);
    }
    fmtSel.value = this.cardCompression?.format ?? 'global';
    // Add "use global" option
    const globalOpt = document.createElement('option');
    globalOpt.value = 'global';
    globalOpt.textContent = '(use global)';
    fmtSel.insertBefore(globalOpt, fmtSel.firstChild);
    fmtSel.addEventListener('change', () => {
      if (fmtSel.value === 'global') {
        if (this.cardCompression) this.cardCompression.format = this.opts.getCompression().format;
      } else {
        if (!this.cardCompression) this.cardCompression = { ...this.opts.getCompression() };
        this.cardCompression.format = fmtSel.value as 'webp' | 'png';
      }
      void this.prepareCompressed();
    });
    fmtLabel.append(fmtSel);

    // Quality slider
    const qLabel = el('label');
    qLabel.innerHTML = `<span>quality</span>`;
    const qInput = document.createElement('input');
    qInput.type = 'range';
    qInput.min = '0.4';
    qInput.max = '1';
    qInput.step = '0.05';
    qInput.value = (this.cardCompression?.quality ?? this.opts.getCompression().quality).toString();
    const qVal = el('span');
    qVal.textContent = qInput.value;
    qInput.addEventListener('input', () => {
      if (!this.cardCompression) this.cardCompression = { ...this.opts.getCompression() };
      this.cardCompression.quality = Number(qInput.value);
      qVal.textContent = qInput.value;
      void this.prepareCompressed();
    });
    qLabel.append(qInput, qVal);

    // Max dimension
    const dLabel = el('label');
    dLabel.innerHTML = `<span>max dim (px)</span>`;
    const dInput = document.createElement('input');
    dInput.type = 'number';
    dInput.min = '64';
    dInput.max = '1024';
    dInput.step = '32';
    dInput.value = this.cardCompression?.maxDim.toString() ?? '';
    dInput.placeholder = 'use global';
    dInput.addEventListener('change', () => {
      if (!dInput.value) {
        // Clear dimension override, use global
        if (this.cardCompression) {
          this.cardCompression.maxDim = this.opts.getCompression().maxDim;
        }
        dInput.value = '';
      } else {
        if (!this.cardCompression) this.cardCompression = { ...this.opts.getCompression() };
        this.cardCompression.maxDim = Math.max(64, Math.min(1024, Number(dInput.value) || 256));
        dInput.value = String(this.cardCompression.maxDim);
      }
      void this.prepareCompressed();
    });
    dLabel.append(dInput);

    // Reset button
    const resetBtn = button('Reset to global', 'btn ghost', () => {
      this.cardCompression = null;
      this.renderCompressionPanel();
      void this.prepareCompressed();
    });

    content.append(fmtLabel, qLabel, dLabel, resetBtn);
    panel.append(content);
    this.root.append(toggle, panel);

    this.compressionToggle = toggle;
    this.compressionPanel = panel;
  }

  private renderCandidates(): void {
    this.candidatesEl.innerHTML = '';
    this.candidates.forEach((cand, i) => {
      const wrap = el('div', 'candidate');
      if (i === this.selectedIdx) wrap.classList.add('selected');
      const img = document.createElement('img');
      img.src = `data:${cand.mimeType};base64,${cand.data}`;
      wrap.append(img);
      const badge = el('span', 'badge');
      badge.textContent = String(i + 1);
      wrap.append(badge);
      wrap.addEventListener('click', () => {
        this.selectedIdx = i;
        this.renderCandidates();
        void this.prepareCompressed();
      });
      this.candidatesEl.append(wrap);
    });
    this.saveBtn.disabled = this.selectedIdx < 0;
    this.downloadBtn.disabled = this.selectedIdx < 0;
    this.removeBgBtn.disabled = this.selectedIdx < 0;
    this.removeGraysBtn.disabled = this.selectedIdx < 0;
  }

  async removeBackground(): Promise<void> {
    if (this.busy || this.selectedIdx < 0) return;
    const src = this.candidates[this.selectedIdx];
    if (!src) return;
    this.setBusy(true);
    this.opts.showStatus(`Removing background for ${this.key}…`);
    try {
      const cut = await removeBackground(src.data, src.mimeType);
      this.candidates[this.selectedIdx] = { data: cut.base64, mimeType: cut.mimeType };
      this.renderCandidates();
      await this.prepareCompressed();
      this.opts.showStatus(`Background removed for ${this.key}`, 'success');
    } catch (err) {
      this.opts.showStatus(
        `remove BG failed: ${(err as Error).message}`,
        'error',
      );
    } finally {
      this.setBusy(false);
    }
  }

  // Second-pass cleanup for pale gray / near-white filler that the
  // main remove-BG step couldn't match (e.g. a grayish haze in the
  // crevices between legs). Border-flooded + low-chroma-gated, so
  // interior whites like eye gems or metallic highlights survive.
  async removeNearWhite(): Promise<void> {
    if (this.busy || this.selectedIdx < 0) return;
    const src = this.candidates[this.selectedIdx];
    if (!src) return;
    this.setBusy(true);
    this.opts.showStatus(`Removing gray filler for ${this.key}…`);
    try {
      const cut = await removeNearWhite(src.data, src.mimeType);
      this.candidates[this.selectedIdx] = {
        data: cut.base64,
        mimeType: cut.mimeType,
      };
      this.renderCandidates();
      await this.prepareCompressed();
      this.opts.showStatus(`Gray filler removed for ${this.key}`, 'success');
    } catch (err) {
      this.opts.showStatus(
        `remove grays failed: ${(err as Error).message}`,
        'error',
      );
    } finally {
      this.setBusy(false);
    }
  }

  private async prepareCompressed(): Promise<void> {
    if (this.selectedIdx < 0) return;
    const src = this.candidates[this.selectedIdx]!;
    // Use card-level compression if set, otherwise fall back to global
    const compression = this.cardCompression ?? this.opts.getCompression();
    const { format, quality, maxDim } = compression;
    try {
      this.compressed = await compressBase64Image(src.data, src.mimeType, {
        format,
        quality,
        maxDimension: maxDim,
      });
    } catch (err) {
      this.opts.showStatus(`compress: ${(err as Error).message}`, 'error');
      this.compressed = null;
    }
  }

  private refreshThumb(path: string | null): void {
    this.thumbEl.innerHTML = '';
    this.thumbEl.classList.remove('empty');
    if (!path) {
      this.thumbEl.classList.add('empty');
      this.thumbEl.textContent = 'no image yet';
      this.metaEl.textContent = 'placeholder';
      this.metaEl.classList.remove('ok');
      this.metaEl.classList.add('warn');
      // No sprite → no history to browse.
      this.historyBtn.disabled = true;
      return;
    }
    const img = document.createElement('img');
    img.src = `${path}?t=${Date.now()}`;
    this.thumbEl.append(img);
    const ext = path.endsWith('.webp') ? 'WEBP' : 'PNG';
    const size = this.compressed?.sizeBytes ?? 0;
    this.metaEl.textContent = `${ext} · ${humanBytes(size)}`;
    this.metaEl.classList.remove('warn');
    this.metaEl.classList.add('ok');
    // Sprite exists on disk → history is queryable even if empty
    // (the list endpoint handles that case with a "no history yet"
    // status toast).
    this.historyBtn.disabled = false;
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.generateBtn.disabled = b;
    if (b) {
      this.generateBtn.textContent = '…';
    } else {
      this.generateBtn.textContent = 'Generate';
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}
function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
