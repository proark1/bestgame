// Admin "Audio" tab — ElevenLabs sound + music generation.
//
// Each card represents one audio key (e.g. `click`, `music-home`).
// Inputs:
//   * prompt textarea (free-text description of the sound or track)
//   * kind dropdown (sfx vs music) — affects which duration knob shows
//   * sfx duration slider (0.5–22 seconds) + prompt-influence slider
//   * music duration slider (10s–5 min) for looped tracks
//   * gain slider (0–1) — written to manifest.json so playback is
//     mixed at the right level without code changes
//   * label textbox so the operator can annotate "warmer", "fast",
//     etc. for the next time they revisit
//
// Buttons per card:
//   * Save prompt — persists the prompt + params to audio-prompts.json
//   * Generate — calls /v1/sound-generation or /v1/music/compose,
//     returns mp3 bytes which we stash on the card so the operator
//     can preview before committing
//   * Save — writes mp3 to /audio/<key>.mp3 + updates manifest.json
//   * Delete — removes file + manifest entry (prompt config stays)
//
// "Add new" button at the top lets the admin create arbitrary keys
// (e.g. `music-special-event`). The runtime audioAssets.ts decoder
// picks up any manifest entry, so new keys ship with no code change.

import {
  deleteAudio,
  deleteAudioPrompt,
  fetchAudioStatus,
  generateAudio,
  putAudioPrompt,
  saveAudio,
  setAudioEnabled,
  type AudioKind,
  type AudioPromptEntry,
  type AudioStatus,
} from './api.js';

type Toast = (msg: string, kind?: 'info' | 'error' | 'success') => void;

interface AudioPanelOptions {
  showStatus: Toast;
}

export function renderAudioPanel(opts: AudioPanelOptions): HTMLElement {
  const root = document.createElement('section');
  root.className = 'audio-tab';

  const header = document.createElement('header');
  header.className = 'audio-tab-header';
  header.innerHTML = `
    <div>
      <h2>Audio</h2>
      <small>Sounds and background music are generated via ElevenLabs. Edit the prompt, generate a preview, then save to ship the .mp3 to <code>client/public/audio/</code> and register it in the runtime manifest.</small>
    </div>
  `;
  const addBtn = document.createElement('button');
  addBtn.className = 'btn accent';
  addBtn.textContent = '+ Add audio key';
  addBtn.addEventListener('click', () => onAddKey());
  header.append(addBtn);
  root.append(header);

  const banner = document.createElement('div');
  banner.className = 'audio-banner';
  banner.hidden = true;
  root.append(banner);

  const grid = document.createElement('div');
  grid.className = 'audio-grid';
  root.append(grid);

  let status: AudioStatus | null = null;

  async function refresh(): Promise<void> {
    try {
      status = await fetchAudioStatus();
    } catch (err) {
      opts.showStatus((err as Error).message, 'error');
      return;
    }
    if (!status.elevenLabsConfigured) {
      banner.hidden = false;
      banner.textContent =
        'ELEVENLABS_API_KEY is not set on the server — generation will fail until it is. Add it under Railway → Variables and redeploy.';
    } else {
      banner.hidden = true;
    }
    drawGrid();
  }

  function drawGrid(): void {
    grid.innerHTML = '';
    if (!status) return;
    // Stable order: music keys first, then sfx; each group alphabetical.
    // Music gets priority because there are fewer of them and the long
    // generation cost makes them the operator's main focus.
    const promptKeys = Object.keys(status.prompts);
    promptKeys.sort((a, b) => {
      const ma = status!.prompts[a]!.kind === 'music' ? 0 : 1;
      const mb = status!.prompts[b]!.kind === 'music' ? 0 : 1;
      return ma !== mb ? ma - mb : a.localeCompare(b);
    });
    if (promptKeys.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'audio-empty';
      empty.textContent =
        'No audio keys configured yet. Click "Add audio key" to create one.';
      grid.append(empty);
      return;
    }
    for (const key of promptKeys) {
      grid.append(buildCard(key, status.prompts[key]!));
    }
  }

  function fileMetaFor(key: string): { filename: string; size: number } | null {
    if (!status) return null;
    const f = status.files.find((x) => x.key === key);
    return f ? { filename: f.filename, size: f.size } : null;
  }

  function buildCard(key: string, entry: AudioPromptEntry): HTMLElement {
    const card = document.createElement('article');
    card.className = `audio-card audio-card-${entry.kind}`;
    const enabled = entry.enabled !== false;
    if (!enabled) card.classList.add('audio-card-disabled');

    // Header: key + kind badge + on-disk status + enable toggle.
    const head = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = key;
    const badge = document.createElement('span');
    badge.className = `audio-badge audio-badge-${entry.kind}`;
    badge.textContent = entry.kind === 'music' ? 'Music' : 'SFX';
    head.append(title, badge);

    // Switch — flips the manifest entry on/off without touching the
    // .mp3 on disk. Disabled keys fall back to the synth (sfx) or the
    // procedural pad (music) at runtime, which is exactly what the
    // operator wants when A/B-ing real vs synthesised audio.
    const toggleWrap = document.createElement('label');
    toggleWrap.className = 'audio-toggle';
    toggleWrap.title = enabled
      ? 'Click to disable — the game will fall back to synth/procedural'
      : 'Click to enable — the saved sample will play in-game';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = enabled;
    const toggleSlider = document.createElement('span');
    toggleSlider.className = 'audio-toggle-slider';
    const toggleLabel = document.createElement('span');
    toggleLabel.className = 'audio-toggle-label';
    toggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';
    toggleWrap.append(toggleInput, toggleSlider, toggleLabel);
    head.append(toggleWrap);

    const meta = fileMetaFor(key);
    const fileNote = document.createElement('small');
    fileNote.className = 'audio-file-note';
    if (meta) {
      fileNote.textContent = `on disk: ${meta.filename} · ${(meta.size / 1024).toFixed(1)} KB`;
    } else {
      fileNote.textContent = 'no file generated yet';
      fileNote.classList.add('audio-file-missing');
    }
    head.append(fileNote);
    card.append(head);

    const tooltipFor = (on: boolean): string =>
      on
        ? 'Click to disable — the game will fall back to synth/procedural'
        : 'Click to enable — the saved sample will play in-game';
    const applyToggleVisuals = (on: boolean): void => {
      toggleLabel.textContent = on ? 'Enabled' : 'Disabled';
      toggleWrap.title = tooltipFor(on);
      card.classList.toggle('audio-card-disabled', !on);
    };

    toggleInput.addEventListener('change', () => {
      const next = toggleInput.checked;
      // Optimistic — flip the UI immediately, roll back on error so
      // the operator always sees the truthful state.
      const prev = !next;
      toggleInput.disabled = true;
      applyToggleVisuals(next);
      void (async () => {
        try {
          await setAudioEnabled(key, next);
          if (status) status.prompts[key] = { ...entry, enabled: next };
          opts.showStatus(
            next
              ? `${key} enabled — reload the game to hear the sample`
              : `${key} disabled — falls back to synth/procedural on next reload`,
            'success',
          );
        } catch (err) {
          toggleInput.checked = prev;
          applyToggleVisuals(prev);
          opts.showStatus((err as Error).message, 'error');
        } finally {
          toggleInput.disabled = false;
        }
      })();
    });

    // Label.
    const labelRow = document.createElement('label');
    labelRow.className = 'audio-row';
    labelRow.innerHTML = '<span>Label</span>';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.maxLength = 120;
    labelInput.value = entry.label ?? '';
    labelInput.placeholder = 'short description';
    labelRow.append(labelInput);
    card.append(labelRow);

    // Prompt.
    const promptRow = document.createElement('label');
    promptRow.className = 'audio-row audio-row-prompt';
    promptRow.innerHTML = '<span>Prompt (sent to ElevenLabs)</span>';
    const promptArea = document.createElement('textarea');
    promptArea.rows = 4;
    promptArea.value = entry.prompt;
    promptArea.placeholder = 'e.g. "short crisp UI button click, soft wooden tap, no reverb"';
    promptRow.append(promptArea);
    card.append(promptRow);

    // Kind selector.
    const kindRow = document.createElement('label');
    kindRow.className = 'audio-row';
    kindRow.innerHTML = '<span>Kind</span>';
    const kindSelect = document.createElement('select');
    for (const k of ['sfx', 'music'] as const) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k === 'sfx' ? 'Sound effect (sfx)' : 'Background music';
      kindSelect.append(opt);
    }
    kindSelect.value = entry.kind;
    kindRow.append(kindSelect);
    card.append(kindRow);

    // Duration controls — different ranges per kind.
    const sfxControls = document.createElement('div');
    sfxControls.className = 'audio-controls';
    const sfxDur = numberInput({
      label: 'Duration (s)',
      min: 0.5,
      max: 22,
      step: 0.1,
      value: entry.durationSeconds ?? 1,
    });
    const sfxInfluence = numberInput({
      label: 'Prompt influence (0–1)',
      min: 0,
      max: 1,
      step: 0.05,
      value: entry.promptInfluence ?? 0.5,
    });
    sfxControls.append(sfxDur.wrap, sfxInfluence.wrap);

    const musicControls = document.createElement('div');
    musicControls.className = 'audio-controls';
    const musicDur = numberInput({
      label: 'Duration (s)',
      min: 10,
      max: 300,
      step: 1,
      value: Math.round((entry.durationMs ?? 30000) / 1000),
    });
    musicControls.append(musicDur.wrap);

    const updateKindUi = (): void => {
      const isMusic = kindSelect.value === 'music';
      sfxControls.style.display = isMusic ? 'none' : '';
      musicControls.style.display = isMusic ? '' : 'none';
    };
    kindSelect.addEventListener('change', updateKindUi);
    card.append(sfxControls, musicControls);
    updateKindUi();

    // Gain.
    const gainCtrl = numberInput({
      label: 'Playback gain (0–1)',
      min: 0,
      max: 1,
      step: 0.05,
      value: entry.gain ?? 0.7,
    });
    const gainRow = document.createElement('div');
    gainRow.className = 'audio-controls';
    gainRow.append(gainCtrl.wrap);
    card.append(gainRow);

    // Preview audio element — appears once Generate succeeds.
    const previewWrap = document.createElement('div');
    previewWrap.className = 'audio-preview';
    const previewAudio = document.createElement('audio');
    previewAudio.controls = true;
    previewAudio.preload = 'none';
    if (meta) {
      // If a file already exists, surface it for playback right away
      // so the operator can hear what's currently shipping.
      previewAudio.src = `/audio/${meta.filename}?t=${Date.now()}`;
    } else {
      previewAudio.style.display = 'none';
    }
    previewWrap.append(previewAudio);
    card.append(previewWrap);

    // Action buttons.
    const actions = document.createElement('div');
    actions.className = 'audio-actions';

    const saveCfgBtn = document.createElement('button');
    saveCfgBtn.className = 'btn';
    saveCfgBtn.textContent = 'Save prompt';
    actions.append(saveCfgBtn);

    const generateBtn = document.createElement('button');
    generateBtn.className = 'btn accent';
    generateBtn.textContent = 'Generate';
    actions.append(generateBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn primary';
    saveBtn.textContent = 'Save audio';
    saveBtn.disabled = true;
    actions.append(saveBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn danger';
    deleteBtn.textContent = 'Delete';
    actions.append(deleteBtn);

    card.append(actions);

    const note = document.createElement('p');
    note.className = 'audio-note';
    card.append(note);

    // Per-card state: the most recent base64 we got back from /generate,
    // not yet saved to disk. Cleared after a successful save.
    let pendingBase64: string | null = null;
    // Track the object URL feeding the preview <audio> so we can revoke
    // it before installing a new one. Without this, every regenerate
    // leaks ~one mp3's worth of bytes that the GC can't collect until
    // the page reloads.
    let previewObjectUrl: string | null = null;

    const collectEntry = (): AudioPromptEntry => {
      const kind = kindSelect.value as AudioKind;
      const out: AudioPromptEntry = {
        prompt: promptArea.value.trim(),
        kind,
      };
      if (kind === 'sfx') {
        out.durationSeconds = clamp(sfxDur.value(), 0.5, 22);
        out.promptInfluence = clamp(sfxInfluence.value(), 0, 1);
      } else {
        out.durationMs = clamp(Math.round(musicDur.value() * 1000), 10000, 300000);
      }
      out.gain = clamp(gainCtrl.value(), 0, 1);
      const lbl = labelInput.value.trim();
      if (lbl) out.label = lbl.slice(0, 120);
      return out;
    };

    saveCfgBtn.addEventListener('click', () => {
      void (async () => {
        const next = collectEntry();
        if (!next.prompt) {
          opts.showStatus('Prompt cannot be empty', 'error');
          return;
        }
        saveCfgBtn.disabled = true;
        try {
          await putAudioPrompt(key, next);
          opts.showStatus(`${key} prompt saved`, 'success');
          // Refresh local view of prompts so the next render keeps state.
          if (status) status.prompts[key] = next;
        } catch (err) {
          opts.showStatus((err as Error).message, 'error');
        } finally {
          saveCfgBtn.disabled = false;
        }
      })();
    });

    generateBtn.addEventListener('click', () => {
      void (async () => {
        const next = collectEntry();
        if (!next.prompt) {
          opts.showStatus('Prompt cannot be empty', 'error');
          return;
        }
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating…';
        note.textContent = '';
        try {
          // Save prompt config first so what the operator hears matches
          // what gets persisted in the repo. Best-effort — a failure
          // here doesn't block the actual generation.
          try {
            await putAudioPrompt(key, next);
            if (status) status.prompts[key] = next;
          } catch {
            // ignore — generation is the user's primary action
          }
          const res = await generateAudio({
            key,
            prompt: next.prompt,
            kind: next.kind,
            ...(next.durationSeconds !== undefined && {
              durationSeconds: next.durationSeconds,
            }),
            ...(next.durationMs !== undefined && {
              durationMs: next.durationMs,
            }),
            ...(next.promptInfluence !== undefined && {
              promptInfluence: next.promptInfluence,
            }),
          });
          pendingBase64 = res.audio.data;
          // Build a blob: URL so the <audio> element can preview the
          // raw bytes without round-tripping through disk. Revoke the
          // previous URL first — otherwise repeat regenerations
          // accumulate blobs in memory until the page reloads.
          const blob = base64ToBlob(res.audio.data, 'audio/mpeg');
          if (previewObjectUrl) {
            URL.revokeObjectURL(previewObjectUrl);
          }
          previewObjectUrl = URL.createObjectURL(blob);
          previewAudio.src = previewObjectUrl;
          previewAudio.style.display = '';
          previewAudio.load();
          saveBtn.disabled = false;
          note.textContent = `Generated ${(res.audio.size / 1024).toFixed(1)} KB. Preview above. Save to publish.`;
        } catch (err) {
          opts.showStatus((err as Error).message, 'error');
          note.textContent = `Error: ${(err as Error).message}`;
        } finally {
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate';
        }
      })();
    });

    saveBtn.addEventListener('click', () => {
      void (async () => {
        if (!pendingBase64) {
          opts.showStatus('Nothing to save — click Generate first', 'info');
          return;
        }
        const next = collectEntry();
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          const res = await saveAudio({
            key,
            data: pendingBase64,
            ...(next.gain !== undefined && { gain: next.gain }),
          });
          opts.showStatus(
            `${key} saved · ${res.path} · ${(res.size / 1024).toFixed(1)} KB`,
            'success',
          );
          pendingBase64 = null;
          await refresh();
        } catch (err) {
          opts.showStatus((err as Error).message, 'error');
        } finally {
          saveBtn.disabled = pendingBase64 === null;
          saveBtn.textContent = 'Save audio';
        }
      })();
    });

    deleteBtn.addEventListener('click', () => {
      void (async () => {
        if (
          !window.confirm(
            `Delete audio "${key}"?\n\nThis removes the .mp3 file and the manifest entry. The prompt config stays — delete that separately.`,
          )
        ) {
          return;
        }
        try {
          await deleteAudio(key);
          opts.showStatus(`${key} file removed`, 'success');
          await refresh();
        } catch (err) {
          opts.showStatus((err as Error).message, 'error');
        }
      })();
    });

    // Right-click delete for the prompt itself — the common case is
    // "remove this whole audio key from the panel", which also wants
    // the prompt entry gone. Bound to the contextmenu (right-click /
    // long-press on touch) instead of an extra button so the row
    // stays compact. The native context menu is suppressed.
    deleteBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void (async () => {
        if (
          !window.confirm(
            `Remove the entire "${key}" prompt entry from audio-prompts.json?\n\nThis also deletes any generated file.`,
          )
        ) {
          return;
        }
        try {
          await deleteAudio(key).catch(() => undefined);
          await deleteAudioPrompt(key);
          opts.showStatus(`${key} fully removed`, 'success');
          await refresh();
        } catch (err) {
          opts.showStatus((err as Error).message, 'error');
        }
      })();
    });

    return card;
  }

  function onAddKey(): void {
    const key = window.prompt(
      'New audio key (lowercase letters, digits, dashes):\n\nUse the prefix "music-" for background music tracks (e.g. "music-boss-fight").',
      'sfx-new',
    );
    if (!key) return;
    const trimmed = key.trim();
    // Mirror the server-side regex so the operator sees an error in
    // the same modal flow instead of a 400 round-trip toast.
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(trimmed)) {
      opts.showStatus(
        'Key must start with a letter or digit and contain only letters, digits, "-", or "_" (2–64 chars).',
        'error',
      );
      return;
    }
    if (status && Object.prototype.hasOwnProperty.call(status.prompts, trimmed)) {
      opts.showStatus(`Key "${trimmed}" already exists.`, 'error');
      return;
    }
    const isMusic = trimmed.startsWith('music-');
    const entry: AudioPromptEntry = {
      prompt: '',
      kind: isMusic ? 'music' : 'sfx',
      ...(isMusic ? { durationMs: 30000 } : { durationSeconds: 1, promptInfluence: 0.6 }),
      gain: isMusic ? 0.25 : 0.6,
    };
    void (async () => {
      try {
        await putAudioPrompt(trimmed, entry);
        opts.showStatus(`Added ${trimmed} — fill in the prompt and click Generate`, 'success');
        await refresh();
      } catch (err) {
        opts.showStatus((err as Error).message, 'error');
      }
    })();
  }

  void refresh();
  return root;
}

interface NumberCtl {
  wrap: HTMLElement;
  value: () => number;
}
function numberInput(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
}): NumberCtl {
  const wrap = document.createElement('label');
  wrap.className = 'audio-num';
  const span = document.createElement('span');
  span.textContent = opts.label;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  wrap.append(span, input);
  return {
    wrap,
    value: () => {
      const n = Number(input.value);
      return Number.isFinite(n) ? n : opts.value;
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function base64ToBlob(b64: string, mime: string): Blob {
  // Uint8Array.from with a callback is the fast path here — V8 / JSC
  // both have native intrinsics for it, whereas a hand-rolled loop
  // with charCodeAt allocates one tagged value per byte. Material
  // for 5-minute mp3s, which can be several MB.
  const arr = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([arr], { type: mime });
}
