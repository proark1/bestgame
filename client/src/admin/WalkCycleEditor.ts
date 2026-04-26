// Per-kind walk-cycle editor. Two side-by-side pose columns, each
// with a preview, a prompt textarea, and three action buttons
// (Regenerate, Remove BG, Remove grays). A single "Save strip"
// button composites the two current poses and persists the
// spritesheet.
//
// Why this shape:
// - The old flow fired pose A + pose B in one shot and saved the
//   composited strip. There was no way to iterate on just one of
//   the two frames.
// - With the reference-image pipeline, pose B is only as good as
//   pose A. If the admin likes pose A but pose B came back off-
//   model, they want to regenerate just B — not blow away pose A
//   by re-running the whole pipeline.
// - Remove BG / Remove grays are per-pose too so the admin can
//   clean each frame independently before committing.
//
// State is held in a module-level scratch Map so re-renders of
// the animation panel (triggered by file-listing refreshes) don't
// lose an in-progress generation.

import {
  compressBase64Image,
  humanBytes,
} from './compress.js';
import {
  generateImages,
  saveSprite,
  updatePrompt,
  type GeminiImage,
  type PromptsFile,
  type SpriteFile,
} from './api.js';
import { removeBackground, removeNearWhite } from './removeBackground.js';
import { autoCropAndCenter } from './cropImage.js';
import {
  WALK_FRAME_COUNT,
  WALK_STRIP_WIDTH,
  composeWalkPosePrompt,
  composeWalkPoseVariationPrompt,
  compositeWalkStrip,
  splitWalkStrip,
} from './walkCycle.js';

export type PoseLabel = 'A' | 'B';

export interface WalkCycleEditorDeps {
  kind: string;
  // Accessors rather than a direct state reference — lets the
  // editor survive renderAnimationPanel() rebuilds without a dead
  // state pointer.
  getPrompts: () => PromptsFile | null;
  setPromptInState: (promptKey: string, value: string) => void;
  getStyleLock: () => string;
  getFiles: () => readonly SpriteFile[];
  showStatus: (msg: string, kind?: 'info' | 'error' | 'success') => void;
  // Called after a successful save so the parent can refresh file
  // listings + re-render the panel.
  onStripSaved: () => void | Promise<void>;
}

interface ScratchEntry {
  poseA: GeminiImage | null;
  poseB: GeminiImage | null;
  // Last-seen on-disk mtime we auto-seeded from. If the file mtime
  // on disk advances (e.g. another tab saved) we re-seed. Zero
  // means "never seeded".
  seededFromMtime: number;
}

const scratch = new Map<string, ScratchEntry>();

function getScratch(kind: string): ScratchEntry {
  let s = scratch.get(kind);
  if (!s) {
    s = { poseA: null, poseB: null, seededFromMtime: 0 };
    scratch.set(kind, s);
  }
  return s;
}

export class WalkCycleEditor {
  readonly root: HTMLDivElement;
  private readonly deps: WalkCycleEditorDeps;

  private previewA!: HTMLImageElement;
  private previewB!: HTMLImageElement;
  private promptAEl!: HTMLTextAreaElement;
  private promptBEl!: HTMLTextAreaElement;
  private regenABtn!: HTMLButtonElement;
  private regenBBtn!: HTMLButtonElement;
  private bgABtn!: HTMLButtonElement;
  private bgBBtn!: HTMLButtonElement;
  private graysABtn!: HTMLButtonElement;
  private graysBBtn!: HTMLButtonElement;
  private cropABtn!: HTMLButtonElement;
  private cropBBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;

  private busy = false;

  constructor(deps: WalkCycleEditorDeps) {
    this.deps = deps;
    this.root = document.createElement('div');
    this.root.className = 'admin-walk-editor';
    this.render();
    void this.seedFromDiskIfNeeded();
  }

  // Check whether pose A/B scratch is empty AND there's an on-disk
  // strip newer than the last seed. If so, fetch the strip and
  // split it into two frames so the editor opens with something
  // visible. Non-critical — failures are swallowed.
  private async seedFromDiskIfNeeded(): Promise<void> {
    const s = getScratch(this.deps.kind);
    const fileName = `unit-${this.deps.kind}-walk`;
    const file = this.deps
      .getFiles()
      .find((f) => f.name === `${fileName}.webp` || f.name === `${fileName}.png`);
    if (!file) return;
    if (s.seededFromMtime >= file.mtime) return;
    if (s.poseA || s.poseB) {
      // Editor already has in-progress content; don't clobber.
      s.seededFromMtime = file.mtime;
      return;
    }
    const url = `/assets/sprites/${file.name}?v=${file.mtime}`;
    const frames = await splitWalkStrip(url, WALK_FRAME_COUNT);
    if (!frames || frames.length < 2) return;
    s.poseA = frames[0] ?? null;
    s.poseB = frames[1] ?? null;
    s.seededFromMtime = file.mtime;
    this.refreshPreviews();
    this.refreshButtons();
  }

  private render(): void {
    this.root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'admin-walk-editor-head';
    header.innerHTML = `
      <strong>${escapeHtml(this.deps.kind)} — pose editor</strong>
      <small>Iterate on each pose independently; click <b>Save strip</b> when both look right.</small>
    `;
    this.root.append(header);

    const poses = document.createElement('div');
    poses.className = 'admin-walk-poses';
    poses.append(this.buildPoseColumn('A'), this.buildPoseColumn('B'));
    this.root.append(poses);

    const footer = document.createElement('div');
    footer.className = 'admin-walk-editor-foot';
    this.saveBtn = mkButton('Save strip', 'btn primary', () => void this.saveStrip());
    footer.append(this.saveBtn);
    this.root.append(footer);

    this.refreshButtons();
  }

  private buildPoseColumn(label: PoseLabel): HTMLElement {
    const col = document.createElement('div');
    col.className = 'admin-walk-pose';

    const title = document.createElement('strong');
    title.textContent = `Pose ${label}`;
    col.append(title);

    const preview = document.createElement('img');
    preview.className = 'admin-walk-pose-preview';
    preview.alt = `${this.deps.kind} pose ${label} preview`;
    col.append(preview);
    if (label === 'A') this.previewA = preview;
    else this.previewB = preview;

    const promptKey = `${this.deps.kind}_pose${label}`;
    const prompt = document.createElement('textarea');
    prompt.className = 'admin-walk-pose-prompt';
    prompt.value = this.deps.getPrompts()?.walkCycles?.[promptKey] ?? '';
    prompt.placeholder =
      label === 'A'
        ? 'Describe pose A (character + base stance)…'
        : 'Describe ONLY the change from pose A (e.g. "legs swap; everything else stays identical to the reference")…';
    prompt.rows = 3;
    // `change` fires on blur — save then. Keep the UI responsive
    // without a save button per textarea (Save strip handles the
    // commit flow; prompt edits autosave).
    prompt.addEventListener('change', async () => {
      try {
        await updatePrompt({
          category: 'walkCycles',
          key: promptKey,
          value: prompt.value,
        });
        this.deps.setPromptInState(promptKey, prompt.value);
        this.deps.showStatus(`Pose ${label} prompt saved`, 'success');
      } catch (err) {
        this.deps.showStatus(`Prompt save failed: ${(err as Error).message}`, 'error');
      }
    });
    col.append(prompt);
    if (label === 'A') this.promptAEl = prompt;
    else this.promptBEl = prompt;

    const actions = document.createElement('div');
    actions.className = 'admin-walk-pose-actions';

    const regenBtn = mkButton(
      'Regenerate',
      'btn accent',
      () => void this.regeneratePose(label),
    );
    const bgBtn = mkButton('Remove BG', 'btn', () =>
      void this.removeBgOn(label),
    );
    const graysBtn = mkButton('Remove grays', 'btn', () =>
      void this.removeGraysOn(label),
    );
    // Auto-trim transparent space around the pose and re-center it
    // in the 128×128 canvas. "Crop" preserves the subject scale;
    // "Crop + fit" scales up to ~90% of the canvas. Both idempotent
    // so the admin can refine after a Remove BG / Remove grays pass.
    const cropBtn = mkButton('Crop', 'btn', () =>
      void this.cropOn(label, 'preserve'),
    );
    const cropFitBtn = mkButton('Crop + fit', 'btn', () =>
      void this.cropOn(label, 'fit'),
    );
    actions.append(regenBtn, bgBtn, graysBtn, cropBtn, cropFitBtn);
    col.append(actions);

    if (label === 'A') {
      this.regenABtn = regenBtn;
      this.bgABtn = bgBtn;
      this.graysABtn = graysBtn;
      this.cropABtn = cropBtn;
    } else {
      this.regenBBtn = regenBtn;
      this.bgBBtn = bgBtn;
      this.graysBBtn = graysBtn;
      this.cropBBtn = cropBtn;
    }
    // cropFitBtn is redundant to track per-side (it just calls
    // cropOn in 'fit' mode, refresh logic mirrors crop). Not
    // assigning to a field keeps the class footprint smaller.
    void cropFitBtn;

    return col;
  }

  private refreshPreviews(): void {
    const s = getScratch(this.deps.kind);
    this.applyPreview(this.previewA, s.poseA);
    this.applyPreview(this.previewB, s.poseB);
  }

  private applyPreview(img: HTMLImageElement, gem: GeminiImage | null): void {
    if (!gem) {
      img.removeAttribute('src');
      img.classList.add('empty');
      return;
    }
    img.src = `data:${gem.mimeType};base64,${gem.data}`;
    img.classList.remove('empty');
  }

  private refreshButtons(): void {
    const s = getScratch(this.deps.kind);
    const hasA = !!s.poseA;
    const hasB = !!s.poseB;
    const b = this.busy;
    this.regenABtn.disabled = b;
    this.regenBBtn.disabled = b || !hasA; // pose B needs pose A as reference
    this.bgABtn.disabled = b || !hasA;
    this.graysABtn.disabled = b || !hasA;
    this.bgBBtn.disabled = b || !hasB;
    this.graysBBtn.disabled = b || !hasB;
    this.cropABtn.disabled = b || !hasA;
    this.cropBBtn.disabled = b || !hasB;
    this.saveBtn.disabled = b || !hasA || !hasB;
    this.regenBBtn.title = hasA
      ? 'Regenerate pose B using the current pose A as a reference image'
      : 'Generate pose A first — pose B uses it as a reference';
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.refreshButtons();
  }

  async regeneratePose(label: PoseLabel): Promise<void> {
    if (this.busy) return;
    const s = getScratch(this.deps.kind);
    const promptKey = `${this.deps.kind}_pose${label}`;
    const description =
      (label === 'A' ? this.promptAEl.value : this.promptBEl.value).trim();
    if (!description) {
      this.deps.showStatus(
        `Pose ${label} prompt is empty — fill the textarea first`,
        'error',
      );
      return;
    }
    if (label === 'B' && !s.poseA) {
      this.deps.showStatus('Generate pose A first', 'error');
      return;
    }
    this.setBusy(true);
    this.deps.showStatus(
      `Regenerating ${this.deps.kind} pose ${label}…`,
      'info',
    );
    try {
      let img: GeminiImage;
      if (label === 'A') {
        const prompt = composeWalkPosePrompt(description, this.deps.getStyleLock());
        const res = await generateImages({ prompt, variants: 1 });
        if (!res[0]) throw new Error('Gemini returned no image');
        img = res[0];
        s.poseA = img;
      } else {
        const prompt = composeWalkPoseVariationPrompt(description);
        const res = await generateImages({
          prompt,
          variants: 1,
          referenceImages: [s.poseA!],
        });
        if (!res[0]) throw new Error('Gemini returned no image');
        img = res[0];
        s.poseB = img;
      }
      // Mirror the prompt edit back into the server now (even if
      // the user already blurred the textarea, this covers the
      // case where they regenerated without tabbing out).
      try {
        await updatePrompt({
          category: 'walkCycles',
          key: promptKey,
          value: description,
        });
        this.deps.setPromptInState(promptKey, description);
      } catch {
        // non-fatal — the generation itself succeeded.
      }
      this.refreshPreviews();
      this.deps.showStatus(`${this.deps.kind} pose ${label} regenerated`, 'success');
    } catch (err) {
      this.deps.showStatus(
        `Regenerate ${label} failed: ${(err as Error).message}`,
        'error',
      );
    } finally {
      this.setBusy(false);
    }
  }

  private async removeBgOn(label: PoseLabel): Promise<void> {
    await this.runCleanup(label, async (gem) => {
      const cut = await removeBackground(gem.data, gem.mimeType);
      return { data: cut.base64, mimeType: cut.mimeType };
    }, 'Remove BG');
  }

  private async removeGraysOn(label: PoseLabel): Promise<void> {
    await this.runCleanup(label, async (gem) => {
      const cut = await removeNearWhite(gem.data, gem.mimeType);
      return { data: cut.base64, mimeType: cut.mimeType };
    }, 'Remove grays');
  }

  private async cropOn(
    label: PoseLabel,
    mode: 'preserve' | 'fit',
  ): Promise<void> {
    const op = mode === 'fit' ? 'Crop + fit' : 'Crop';
    await this.runCleanup(label, async (gem) => {
      const cropped = await autoCropAndCenter(gem.data, gem.mimeType, { mode });
      if (!cropped) {
        throw new Error('image is fully transparent — nothing to crop');
      }
      return { data: cropped.base64, mimeType: cropped.mimeType };
    }, op);
  }

  private async runCleanup(
    label: PoseLabel,
    fn: (src: GeminiImage) => Promise<GeminiImage>,
    opName: string,
  ): Promise<void> {
    if (this.busy) return;
    const s = getScratch(this.deps.kind);
    const src = label === 'A' ? s.poseA : s.poseB;
    if (!src) return;
    this.setBusy(true);
    this.deps.showStatus(`${opName} on pose ${label}…`, 'info');
    try {
      const out = await fn(src);
      if (label === 'A') s.poseA = out;
      else s.poseB = out;
      this.refreshPreviews();
      this.deps.showStatus(`${opName} done on pose ${label}`, 'success');
    } catch (err) {
      this.deps.showStatus(
        `${opName} failed: ${(err as Error).message}`,
        'error',
      );
    } finally {
      this.setBusy(false);
    }
  }

  async saveStrip(): Promise<void> {
    if (this.busy) return;
    const s = getScratch(this.deps.kind);
    if (!s.poseA || !s.poseB) {
      this.deps.showStatus('Both poses required before saving', 'error');
      return;
    }
    this.setBusy(true);
    this.deps.showStatus(`Compositing + saving ${this.deps.kind}…`, 'info');
    try {
      const stripPng = await compositeWalkStrip([s.poseA, s.poseB]);
      const compressed = await compressBase64Image(stripPng, 'image/png', {
        format: 'webp',
        quality: 0.9,
        maxDimension: WALK_STRIP_WIDTH,
      });
      const res = await saveSprite({
        key: `unit-${this.deps.kind}-walk`,
        data: compressed.base64,
        format: 'webp',
        frames: WALK_FRAME_COUNT,
      });
      this.deps.showStatus(
        `Saved ${this.deps.kind} walk strip (${humanBytes(res.size)})`,
        'success',
      );
      await this.deps.onStripSaved();
    } catch (err) {
      this.deps.showStatus(
        `Save strip failed: ${(err as Error).message}`,
        'error',
      );
    } finally {
      this.setBusy(false);
    }
  }
}

function mkButton(
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
