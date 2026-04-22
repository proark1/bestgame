// Server-side Gemini image-generation client. Keeps the API key on the
// server so it's never exposed to the browser. Called only from the
// authenticated /admin/api/generate route.

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models';

// Closed set of Gemini image models we're willing to hit. Anything else
// is refused — stops a malicious admin body from redirecting the URL
// construction to an unexpected endpoint (SSRF defense-in-depth) and
// also protects against silent breakage when the API evolves.
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-image',
  'gemini-2.5-flash-image-preview',
  'imagen-3.0-generate-002',
]);
export const DEFAULT_MODEL = 'gemini-2.5-flash-image';

export interface GeminiImage {
  mimeType: string;
  data: string; // base64 PNG/WebP
}

export interface GeminiGenerateRequest {
  prompt: string;
  variants: number;
  model?: string;
  temperature?: number;
  // Optional reference images attached to the prompt as
  // multimodal context. The Gemini 2.5 flash-image model treats
  // these as visual references — "produce a new image like
  // THIS but different in X way". Used by the walk-cycle
  // generator to keep pose B consistent with pose A.
  referenceImages?: readonly GeminiImage[];
}

export async function geminiGenerateImages(
  req: GeminiGenerateRequest,
): Promise<GeminiImage[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY not configured on the server. Set it in the deployment environment.',
    );
  }
  const model = req.model ?? DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(model)) {
    throw new Error(
      `model "${model}" not allowed. Allowed: ${[...ALLOWED_MODELS].join(', ')}`,
    );
  }
  // encodeURIComponent guards against malformed model strings ever reaching
  // this far; the allowlist above is the primary defense.
  const endpoint = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
    apiKey,
  )}`;
  const variants = Math.max(1, Math.min(4, Math.floor(req.variants || 1)));

  // Build the multimodal parts array once (cheap; we reuse across
  // variant fan-out). Reference images come first so the model sees
  // them before the instruction text — matches Google's
  // recommendation for "image + text" prompts.
  type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
  const promptParts: Part[] = [];
  if (req.referenceImages) {
    for (const img of req.referenceImages) {
      promptParts.push({
        inlineData: { mimeType: img.mimeType, data: img.data },
      });
    }
  }
  promptParts.push({ text: req.prompt });

  // Gemini returns one image per call, so fan out `variants` times.
  // Small N (≤ 4), parallel is fine.
  const jobs = Array.from({ length: variants }, async () => {
    const body = {
      contents: [{ role: 'user', parts: promptParts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        temperature: req.temperature ?? 0.7,
      },
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: string; data?: string };
          }>;
        };
      }>;
    };
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      if (p.inlineData?.data) {
        return {
          mimeType: p.inlineData.mimeType ?? 'image/png',
          data: p.inlineData.data,
        };
      }
    }
    throw new Error('Gemini returned no image data');
  });
  return await Promise.all(jobs);
}
