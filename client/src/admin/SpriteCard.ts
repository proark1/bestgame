// A single sprite card in the admin grid. Encapsulates its own local
// state (prompt text, candidate list, selected index, compression)
// and exposes helpers for the parent app to drive "generate all"
// and bulk operations.

import { compressBase64Image, humanBytes, type CompressedImage } from './compress.js';
import { deleteSprite, generateImages, saveSprite, type GeminiImage } from './api.js';

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

  private thumbEl!: HTMLDivElement;
  private metaEl!: HTMLSpanElement;
  private candidatesEl!: HTMLDivElement;
  private promptEl!: HTMLTextAreaElement;
  private generateBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private downloadBtn!: HTMLButtonElement;
  private variantsSelect!: HTMLSelectElement;

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
    try {
      const res = await saveSprite({
        key: this.key,
        data: this.compressed.base64,
        format: ext,
      });
      this.opts.onSaved({ path: res.path, ext });
      this.opts.showStatus(`Saved ${this.key} (${humanBytes(res.size)})`, 'success');
      // refresh thumb from saved path
      this.refreshThumb(res.path);
    } catch (err) {
      this.opts.showStatus(`save failed: ${(err as Error).message}`, 'error');
    } finally {
      this.setBusy(false);
    }
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

    const actions = el('div', 'card-actions');
    this.generateBtn = button('Generate', 'btn accent', () => void this.generate());
    this.saveBtn = button('Save', 'btn primary', () => void this.save());
    this.downloadBtn = button('Download', 'btn', () => void this.download());
    const delBtn = button('Delete', 'btn ghost danger', () => void this.delete());
    this.saveBtn.disabled = true;
    this.downloadBtn.disabled = true;
    actions.append(this.generateBtn, this.saveBtn, this.downloadBtn, delBtn);

    this.root.append(
      head,
      this.thumbEl,
      this.candidatesEl,
      this.promptEl,
      variantRow,
      actions,
    );
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
  }

  private async prepareCompressed(): Promise<void> {
    if (this.selectedIdx < 0) return;
    const src = this.candidates[this.selectedIdx]!;
    const { format, quality, maxDim } = this.opts.getCompression();
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
