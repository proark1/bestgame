// A single sprite card in the admin grid. Encapsulates its own local
// state (prompt text, candidate list, selected index, compression)
// and exposes helpers for the parent app to drive "generate all"
// and bulk operations.

import {
  blobToBase64,
  compressBase64Image,
  humanBytes,
  type CompressedImage,
} from './compress.js';
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
import { autoCropAndCenter } from './cropImage.js';
import {
  WALK_FRAME_COUNT,
  WALK_STRIP_WIDTH,
  compositeWalkStrip,
  splitWalkStrip,
} from './walkCycle.js';

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
  // Optional animation support. When provided, the card shows an
  // animation section that lets the admin generate a moving variant
  // (legs/wings) using the saved sprite as reference. Used for unit
  // sprites only — buildings/UI/branding skip animation.
  animation?: {
    hasAnimation: () => boolean;
    onGenerate: (onProgress: (note: string) => void) => Promise<void>;
  };
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
  private cropBtn!: HTMLButtonElement;
  private cropFitBtn!: HTMLButtonElement;
  private loadCurrentBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private downloadBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private variantsSelect!: HTMLSelectElement;
  private compressionPanel?: HTMLDivElement;
  private compressionToggle?: HTMLButtonElement;
  private animationPanel?: HTMLDivElement;

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
    // Auto-trim transparent space around the subject and re-center
    // it. Two flavours: "Crop" preserves the subject's native scale
    // (just removes empty side margin); "Crop + fit" also scales the
    // subject up to ~90% of the canvas — useful when the source has
    // heavy padding. Both are idempotent so the admin can click again
    // to refine after a Remove BG / Remove grays pass.
    this.cropBtn = button('Crop', 'btn', () =>
      void this.cropSubject('preserve'),
    );
    this.cropFitBtn = button('Crop + fit', 'btn', () =>
      void this.cropSubject('fit'),
    );
    // Pull the current on-disk sprite into the candidate slot so the
    // admin can edit (Crop / Remove BG / Remove grays) and re-save
    // WITHOUT regenerating. Useful for the common case "this saved
    // sprite has padding I want to crop now". Disabled when nothing
    // is saved yet (nothing to load).
    this.loadCurrentBtn = button('Load current', 'btn', () =>
      void this.loadCurrentSprite(),
    );
    this.saveBtn = button('Save', 'btn primary', () => void this.save());
    this.downloadBtn = button('Download', 'btn', () => void this.download());
    this.historyBtn = button('History', 'btn', () => void this.openHistory());
    const delBtn = button('Delete', 'btn ghost danger', () => void this.delete());
    this.removeBgBtn.disabled = true;
    this.removeGraysBtn.disabled = true;
    this.cropBtn.disabled = true;
    this.cropFitBtn.disabled = true;
    this.saveBtn.disabled = true;
    this.downloadBtn.disabled = true;
    // History + Load current are enabled whenever the sprite exists
    // on disk — they hit the file system / DB and have nothing to do
    // with candidate selection.
    this.historyBtn.disabled = !this.opts.fileMeta.exists;
    this.loadCurrentBtn.disabled = !this.opts.fileMeta.exists;
    if (!this.opts.fileMeta.exists) {
      this.loadCurrentBtn.title = 'No saved sprite to load yet — generate one first.';
    }
    actions.append(
      this.generateBtn,
      this.loadCurrentBtn,
      this.removeBgBtn,
      this.removeGraysBtn,
      this.cropBtn,
      this.cropFitBtn,
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

    // Animation panel — only shown when caller passes animation option
    // (i.e. for unit sprites). Lets the admin generate a moving variant
    // from the saved sprite without leaving the card.
    if (this.opts.animation) {
      this.renderAnimationPanel();
    }
  }

  private renderAnimationPanel(): void {
    // Mirror renderCompressionPanel pattern: clean up any prior instance,
    // then build fresh. Stored as a class property so refreshThumb (or
    // any future state change) can re-render reliably without depending
    // on a captured closure variable.
    this.animationPanel?.remove();
    if (!this.opts.animation) return;
    const anim = this.opts.animation;
    const panel = document.createElement('div');
    panel.className = 'sprite-card-animation';
    this.animationPanel = panel;

    const header = document.createElement('div');
    header.className = 'sprite-card-animation-head';
    const title = document.createElement('span');
    title.className = 'sprite-card-animation-title';
    title.textContent = '🎬 Animation';
    const status = document.createElement('span');
    status.className = 'sprite-card-animation-status';
    const animOk = anim.hasAnimation();
    status.textContent = animOk ? '✓ ready' : '— not generated';
    status.dataset.ok = animOk ? '1' : '0';
    header.append(title, status);
    panel.append(header);

    const note = document.createElement('p');
    note.className = 'sprite-card-animation-note';
    note.textContent = animOk
      ? 'Animation strip exists. Regenerate to create a new variant.'
      : 'Generate a moving variation: legs walk if it has legs, wings flap if flying, both if both. Uses this sprite as reference.';
    panel.append(note);

    // Animation preview — only shown when animation exists
    if (animOk) {
      const previewBox = document.createElement('div');
      previewBox.className = 'sprite-card-animation-preview';
      const previewImg = document.createElement('img');
      // Extract kind from this.key (e.g., "unit-ant" -> "ant")
      const kind = this.key.replace(/^unit-/, '');
      // Load animation strip with cache-bust. Animation files are named:
      // unit-{kind}-walk.{ext} and contain two frames composited into 256×128.
      // Use the sprite's format as primary to stay in sync; fall back to the other
      // format if the primary doesn't exist (handles format changes gracefully).
      const primaryExt = this.opts.fileMeta.ext ?? 'webp';
      const fallbackExt = primaryExt === 'webp' ? 'png' : 'webp';
      previewImg.src = `/assets/sprites/unit-${kind}-walk.${primaryExt}?t=${Date.now()}`;
      previewImg.alt = 'Walk cycle animation';
      previewImg.addEventListener('error', () => {
        previewImg.src = `/assets/sprites/unit-${kind}-walk.${fallbackExt}?t=${Date.now()}`;
      }, { once: true });
      previewBox.append(previewImg);
      panel.append(previewBox);
    }

    const actions = document.createElement('div');
    actions.className = 'sprite-card-animation-actions';

    const genBtn = document.createElement('button');
    genBtn.className = 'btn accent';
    genBtn.textContent = animOk ? 'Regenerate animation' : 'Generate animation';
    genBtn.disabled = !this.opts.fileMeta.exists;
    if (!this.opts.fileMeta.exists) {
      genBtn.title = 'Save the sprite first';
    }
    genBtn.addEventListener('click', async () => {
      if (genBtn.disabled) return;
      genBtn.disabled = true;
      const orig = genBtn.textContent;
      genBtn.textContent = 'Generating…';
      try {
        await anim.onGenerate((msg) => this.opts.showStatus(msg, 'info'));
        this.opts.showStatus(`Animation saved for ${this.key}`, 'success');
        // Re-render via the stored reference path
        this.renderAnimationPanel();
      } catch (err) {
        this.opts.showStatus(
          `Animation failed: ${(err as Error).message}`,
          'error',
        );
        genBtn.textContent = orig;
        genBtn.disabled = false;
      }
    });

    actions.append(genBtn);

    // Manual cleanup buttons for frame 2 (the variation pose). The
    // bulk generator already runs removeBackground on frame 2 once,
    // but Gemini sometimes leaves a faint gray haze the first pass
    // misses — these buttons let the admin re-run BG/grays cleanup on
    // the saved strip without going through the per-pose editor below.
    // Both can be clicked repeatedly until the frame looks clean.
    if (animOk) {
      const cleanBgBtn = document.createElement('button');
      cleanBgBtn.className = 'btn';
      cleanBgBtn.textContent = 'Clean frame 2 BG';
      cleanBgBtn.title =
        'Re-run background removal on the second animation frame and save. Click again if a halo remains.';
      cleanBgBtn.addEventListener('click', () => {
        void this.cleanupAnimationFrame2(cleanBgBtn, 'bg');
      });
      actions.append(cleanBgBtn);

      const cleanGraysBtn = document.createElement('button');
      cleanGraysBtn.className = 'btn';
      cleanGraysBtn.textContent = 'Clean frame 2 grays';
      cleanGraysBtn.title =
        'Re-run gray/white-haze removal on the second animation frame and save. Click again if grays remain.';
      cleanGraysBtn.addEventListener('click', () => {
        void this.cleanupAnimationFrame2(cleanGraysBtn, 'grays');
      });
      actions.append(cleanGraysBtn);
    }

    panel.append(actions);

    this.root.append(panel);
  }

  // Re-clean frame 2 of the saved walk strip. Loads the on-disk file,
  // splits it into 2 frames, applies the requested cleanup to frame 2
  // only, recomposites + saves under the same key. Idempotent: clicking
  // again runs the cleanup on the freshly-saved strip, so a stubborn
  // halo can be peeled in passes.
  private async cleanupAnimationFrame2(
    btn: HTMLButtonElement,
    mode: 'bg' | 'grays',
  ): Promise<void> {
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent ?? '';
    btn.textContent = 'Cleaning…';
    const kind = this.key.replace(/^unit-/, '');
    const opLabel = mode === 'bg' ? 'background' : 'grays';
    try {
      const ext = this.opts.fileMeta.ext ?? 'webp';
      const url = `/assets/sprites/unit-${kind}-walk.${ext}?t=${Date.now()}`;
      const frames = await splitWalkStrip(url, WALK_FRAME_COUNT);
      if (!frames || frames.length < 2) {
        throw new Error('could not load walk strip from disk');
      }
      const frame1 = frames[0]!;
      const frame2 = frames[1]!;
      const cleaned =
        mode === 'bg'
          ? await removeBackground(frame2.data, frame2.mimeType)
          : await removeNearWhite(frame2.data, frame2.mimeType);
      const cleanedFrame: GeminiImage = {
        data: cleaned.base64,
        mimeType: cleaned.mimeType,
      };
      const stripPng = await compositeWalkStrip([frame1, cleanedFrame]);
      // Respect the admin's configured compression quality (card-level
      // override falls back to the global default). Floored at 0.85 to
      // match generateWalkCycle()'s rationale: walk-cycle frames need
      // enough fidelity for the leg/wing motion to read as movement
      // rather than mush, even if the rest of the asset library is set
      // to lower quality.
      const cfg = this.cardCompression ?? this.opts.getCompression();
      const compressed = await compressBase64Image(stripPng, 'image/png', {
        format: ext,
        quality: Math.max(0.85, cfg.quality),
        maxDimension: WALK_STRIP_WIDTH,
      });
      await saveSprite({
        key: `unit-${kind}-walk`,
        data: compressed.base64,
        format: ext,
        frames: WALK_FRAME_COUNT,
      });
      this.opts.showStatus(
        `Cleaned ${opLabel} on frame 2 of ${kind}`,
        'success',
      );
      // Re-render so the preview img picks up the new mtime.
      this.renderAnimationPanel();
    } catch (err) {
      this.opts.showStatus(
        `Frame 2 ${opLabel} cleanup failed: ${(err as Error).message}`,
        'error',
      );
      btn.textContent = orig;
      btn.disabled = false;
    }
  }

  private renderCompressionPanel(): void {
    this.compressionToggle?.remove();
    this.compressionPanel?.remove();

    const panel = el('div', 'compression-panel');
    panel.hidden = true;

    const toggle = document.createElement('button');
    toggle.className = 'btn ghost compress-toggle';
    const overriddenSuffix = (): string => (this.cardCompression ? ' (override)' : '');
    toggle.textContent = `Compression ▼${overriddenSuffix()}`;
    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      // Re-render so the displayed values reflect the LIVE global at
      // expand time — previously the read happened only on first
      // render, so after the admin moved the toolbar slider the card
      // panel still showed stale numbers.
      if (!panel.hidden) this.renderCompressionPanel();
      const arrow = panel.hidden ? '▼' : '▲';
      toggle.textContent = `Compression ${arrow}${overriddenSuffix()}`;
    });

    const content = el('div', 'compression-content');

    // Override toggle. When OFF (default), every control below is
    // disabled and shows the LIVE global value — saves use the
    // global compression. When ON, controls become editable and a
    // per-card override is created. This matches "global setting is
    // the default, per-card kicks in only on explicit opt-in".
    const overrideRow = el('div', 'stat-row');
    const overrideLabel = el('label');
    const overrideInput = document.createElement('input');
    overrideInput.type = 'checkbox';
    overrideInput.checked = this.cardCompression !== null;
    overrideLabel.append(overrideInput, document.createTextNode(' Override for this sprite'));
    overrideRow.append(overrideLabel);

    // Format selector — reflects effective compression (override or
    // global). Only writable when override is on.
    const eff = this.cardCompression ?? this.opts.getCompression();
    const fmtLabel = el('label');
    fmtLabel.innerHTML = `<span>format</span>`;
    const fmtSel = document.createElement('select');
    for (const f of ['webp', 'png']) {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f.toUpperCase();
      fmtSel.append(opt);
    }
    fmtSel.value = eff.format;
    fmtSel.disabled = !overrideInput.checked;
    fmtSel.addEventListener('change', () => {
      if (!this.cardCompression) return; // shouldn't happen — gated by checkbox
      this.cardCompression.format = fmtSel.value as 'webp' | 'png';
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
    qInput.value = String(eff.quality);
    qInput.disabled = !overrideInput.checked;
    const qVal = el('span');
    qVal.textContent = qInput.value;
    qInput.addEventListener('input', () => {
      if (!this.cardCompression) return;
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
    dInput.value = String(eff.maxDim);
    dInput.disabled = !overrideInput.checked;
    dInput.addEventListener('change', () => {
      if (!this.cardCompression) return;
      const next = Math.max(64, Math.min(1024, Number(dInput.value) || eff.maxDim));
      this.cardCompression.maxDim = next;
      dInput.value = String(next);
      void this.prepareCompressed();
    });
    dLabel.append(dInput);

    overrideInput.addEventListener('change', () => {
      if (overrideInput.checked) {
        // Seed the override from the LIVE global so the controls
        // start at the same values the admin sees on the toolbar.
        this.cardCompression = { ...this.opts.getCompression() };
      } else {
        this.cardCompression = null;
      }
      // Re-render so all controls flip enabled/disabled in sync and
      // the toggle title reflects the new state.
      this.renderCompressionPanel();
      void this.prepareCompressed();
    });

    content.append(overrideRow, fmtLabel, qLabel, dLabel);
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
    this.cropBtn.disabled = this.selectedIdx < 0;
    this.cropFitBtn.disabled = this.selectedIdx < 0;
  }

  // Auto-trim transparent space around the subject and re-center it
  // in the original canvas. Use 'preserve' to keep the subject's
  // native scale (just remove side padding) or 'fit' to scale up to
  // ~90% of the canvas. Idempotent — re-clicking after a Remove BG
  // pass will tighten further if more pixels were cleared.
  // Fetch the saved on-disk sprite and slot it in as a candidate so
  // the admin can edit (Crop, Remove BG, Remove grays) + re-save
  // WITHOUT going through Generate. Use case: the saved sprite has
  // unwanted padding the admin wants to trim, or a haze the first
  // remove-grays pass missed. Subsequent Save calls overwrite the
  // same key and create a new history row.
  async loadCurrentSprite(): Promise<void> {
    if (this.busy) return;
    if (!this.opts.fileMeta.exists) {
      this.opts.showStatus(
        `${this.key}: nothing saved yet — Generate first.`,
        'error',
      );
      return;
    }
    this.setBusy(true);
    this.opts.showStatus(`Loading saved ${this.key}…`);
    try {
      const ext = this.opts.fileMeta.ext ?? 'webp';
      // Cache-bust so we always get the latest mtime even if the
      // browser has a stale copy from the thumb render.
      const url = `/assets/sprites/${this.key}.${ext}?t=${Date.now()}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      const blob = await resp.blob();
      const base64 = await blobToBase64(blob);
      const mimeType = blob.type || (ext === 'png' ? 'image/png' : 'image/webp');
      this.candidates = [{ data: base64, mimeType }];
      this.selectedIdx = 0;
      this.renderCandidates();
      await this.prepareCompressed();
      this.opts.showStatus(
        `Loaded saved ${this.key} — edit then Save to overwrite.`,
        'success',
      );
    } catch (err) {
      this.opts.showStatus(
        `Load current failed: ${(err as Error).message}`,
        'error',
      );
    } finally {
      this.setBusy(false);
    }
  }

  async cropSubject(mode: 'preserve' | 'fit'): Promise<void> {
    if (this.busy || this.selectedIdx < 0) return;
    const src = this.candidates[this.selectedIdx];
    if (!src) return;
    this.setBusy(true);
    const label = mode === 'fit' ? 'cropping + fitting' : 'cropping';
    this.opts.showStatus(`${label} ${this.key}…`);
    try {
      const cropped = await autoCropAndCenter(src.data, src.mimeType, { mode });
      if (!cropped) {
        this.opts.showStatus(
          `${this.key}: nothing to crop (image is fully transparent)`,
          'error',
        );
        return;
      }
      this.candidates[this.selectedIdx] = {
        data: cropped.base64,
        mimeType: cropped.mimeType,
      };
      this.renderCandidates();
      await this.prepareCompressed();
      const { w, h } = cropped.subjectBox;
      this.opts.showStatus(
        `Cropped ${this.key} (subject ${w}×${h}, centered)`,
        'success',
      );
    } catch (err) {
      this.opts.showStatus(
        `crop failed: ${(err as Error).message}`,
        'error',
      );
    } finally {
      this.setBusy(false);
    }
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
      // Keep fileMeta in sync so the animation panel's enable/disable
      // logic and any other readers see the current truth.
      this.opts.fileMeta.exists = false;
      this.opts.fileMeta.ext = null;
      this.opts.fileMeta.size = 0;
      this.renderAnimationPanel();
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
    // Sync fileMeta and re-render the animation panel so its
    // "Generate animation" button enables immediately after a save.
    this.opts.fileMeta.exists = true;
    this.opts.fileMeta.ext = path.endsWith('.webp') ? 'webp' : 'png';
    this.opts.fileMeta.size = this.compressed?.sizeBytes ?? this.opts.fileMeta.size;
    this.renderAnimationPanel();
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
