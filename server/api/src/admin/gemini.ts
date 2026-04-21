// Server-side Gemini image-generation client. Keeps the API key on the
// server so it's never exposed to the browser. Called only from the
// authenticated /admin/api/generate route.

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiImage {
  mimeType: string;
  data: string; // base64 PNG/WebP
}

export interface GeminiGenerateRequest {
  prompt: string;
  variants: number;
  model?: string;
  temperature?: number;
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
  const model = req.model ?? 'gemini-2.5-flash-image';
  const endpoint = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(
    apiKey,
  )}`;
  const variants = Math.max(1, Math.min(4, Math.floor(req.variants || 1)));

  // Gemini returns one image per call, so fan out `variants` times.
  // Small N (≤ 4), parallel is fine.
  const jobs = Array.from({ length: variants }, async () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
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
