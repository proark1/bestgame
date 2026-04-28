// Server-side ElevenLabs audio-generation client. Keeps the API key on
// the server (ELEVENLABS_API_KEY) so it's never exposed to the browser.
// Called only from the authenticated /admin/api/audio/* routes.
//
// Two flavours:
//   * sound effect — POST /v1/sound-generation, takes a text prompt and
//     a duration_seconds (0.5 – 22). Returns mp3 bytes.
//   * music — POST /v1/music/compose, takes a longer text prompt and
//     a music_length_ms (≥ 10000). Returns mp3 bytes.
//
// Both endpoints stream the audio body straight back; we buffer + base64
// for the admin response so the browser can preview before saving.

const ELEVEN_BASE = 'https://api.elevenlabs.io';

export interface ElevenLabsSfxRequest {
  prompt: string;
  // Seconds. ElevenLabs allows 0.5 – 22; we clamp.
  durationSeconds?: number;
  // 0..1 — how strictly the model follows the prompt vs. its own
  // creativity. Higher = closer match, lower = more variety.
  promptInfluence?: number;
}

export interface ElevenLabsMusicRequest {
  prompt: string;
  // Milliseconds. ElevenLabs music compose minimum is 10s.
  durationMs?: number;
}

export interface ElevenLabsAudio {
  // base64-encoded mp3
  data: string;
  mimeType: 'audio/mpeg';
  size: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

async function fetchAudio(url: string, body: unknown, apiKey: string): Promise<ElevenLabsAudio> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // ElevenLabs returns JSON errors with { detail: { status, message } }
    // — surface the message so the admin UI sees something useful.
    const text = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${text.slice(0, 400)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('ElevenLabs returned empty audio body');
  return {
    data: buf.toString('base64'),
    mimeType: 'audio/mpeg',
    size: buf.length,
  };
}

function requireKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error(
      'ELEVENLABS_API_KEY not configured on the server. Set it in the deployment environment (Railway → Variables) and redeploy.',
    );
  }
  return key;
}

export async function generateSfx(req: ElevenLabsSfxRequest): Promise<ElevenLabsAudio> {
  if (!req.prompt || req.prompt.trim() === '') {
    throw new Error('prompt required');
  }
  const apiKey = requireKey();
  const duration = clamp(req.durationSeconds ?? 2, 0.5, 22);
  const influence = clamp(req.promptInfluence ?? 0.5, 0, 1);
  return fetchAudio(
    `${ELEVEN_BASE}/v1/sound-generation`,
    {
      text: req.prompt,
      duration_seconds: duration,
      prompt_influence: influence,
    },
    apiKey,
  );
}

export async function generateMusic(req: ElevenLabsMusicRequest): Promise<ElevenLabsAudio> {
  if (!req.prompt || req.prompt.trim() === '') {
    throw new Error('prompt required');
  }
  const apiKey = requireKey();
  // ElevenLabs music compose: minimum 10s, capped at 5 min so an admin
  // typo can't burn through credits on a 30-minute gen.
  const durationMs = clamp(req.durationMs ?? 30000, 10000, 5 * 60 * 1000);
  return fetchAudio(
    `${ELEVEN_BASE}/v1/music/compose`,
    {
      prompt: req.prompt,
      music_length_ms: durationMs,
    },
    apiKey,
  );
}

export function elevenLabsConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}
