// Image generation with automatic fallback:
//   1. Hugging Face Inference API (FLUX.1-schnell) — fast, free tier with HF_TOKEN
//   2. Gemini 2.5 Flash Image (GOOGLE_AI_KEY) — good quality, requires billing enabled
//
// At least one of HUGGINGFACE_API_KEY or GOOGLE_AI_KEY must be set.

const HF_MODEL = "black-forest-labs/FLUX.1-schnell";
const HF_API = `https://router.huggingface.co/hf-inference/models/${HF_MODEL}`;

const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── Hugging Face ─────────────────────────────────────────────────────────────

async function generateViaHuggingFace(
  prompt: string,
  hfToken: string,
): Promise<{ b64_json: string; mimeType: string }> {
  console.log("[Image] Requesting via Hugging Face FLUX.1-schnell...");

  let lastError = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(HF_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hfToken}`,
          "Content-Type": "application/json",
          "x-wait-for-model": "true",
        },
        body: JSON.stringify({ inputs: prompt }),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.status === 503) {
        // Model is loading — HF tells us to wait
        lastError = "Model loading (503)";
        console.warn(`[Image] HF model loading, retrying in ${5 * attempt}s...`);
        await new Promise((r) => setTimeout(r, 5000 * attempt));
        continue;
      }

      if (res.status === 429) {
        lastError = "Rate limited (429)";
        await new Promise((r) => setTimeout(r, 10_000 * attempt));
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        lastError = `HTTP ${res.status}: ${body.slice(0, 100)}`;
        console.warn(`[Image] HF attempt ${attempt} failed: ${lastError}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }

      const mimeType = res.headers.get("content-type") ?? "image/jpeg";
      const buffer = await res.arrayBuffer();
      const b64_json = Buffer.from(buffer).toString("base64");

      console.log(
        `[Image] ✅ HF FLUX returned ${Math.round(buffer.byteLength / 1024)}KB (${mimeType})`,
      );
      return { b64_json, mimeType };
    } catch (err: any) {
      lastError = err?.message ?? String(err);
      console.warn(`[Image] HF attempt ${attempt} error:`, lastError);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }

  throw new Error(`HF image generation failed: ${lastError}`);
}

// ─── Gemini Image ─────────────────────────────────────────────────────────────

async function generateViaGemini(
  prompt: string,
  apiKey: string,
): Promise<{ b64_json: string; mimeType: string }> {
  const url = `${GEMINI_API_BASE}/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;

  console.log("[Image] Requesting via Gemini 2.5 Flash Image...");

  let lastError = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: `Generate an image: ${prompt}` }],
            },
          ],
          generationConfig: {
            responseModalities: ["image", "text"],
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const wait = retryAfter ? parseInt(retryAfter) * 1000 : 8000 * attempt;
        lastError = `Rate limited (attempt ${attempt})`;
        console.warn(`[Image] Gemini rate limited, waiting ${Math.round(wait / 1000)}s...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        lastError = `HTTP ${res.status}: ${errBody.slice(0, 100)}`;
        console.warn(`[Image] Gemini attempt ${attempt} failed: ${lastError}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }

      const data = await res.json() as any;
      const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
      const imgPart = parts.find(
        (p: any) => p.inlineData?.mimeType?.startsWith("image/"),
      );

      if (!imgPart) {
        lastError = "No image in Gemini response";
        console.warn(`[Image] Gemini attempt ${attempt}: ${lastError}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }

      const mimeType: string = imgPart.inlineData.mimeType;
      const b64_json: string = imgPart.inlineData.data;

      console.log(
        `[Image] ✅ Gemini returned ~${Math.round((b64_json.length * 0.75) / 1024)}KB (${mimeType})`,
      );
      return { b64_json, mimeType };
    } catch (err: any) {
      lastError = err?.message ?? String(err);
      console.warn(`[Image] Gemini attempt ${attempt} error:`, lastError);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }

  throw new Error(`Gemini image generation failed: ${lastError}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateImage(
  prompt: string,
): Promise<{ b64_json: string; mimeType: string }> {
  const hfToken = process.env.HUGGINGFACE_API_KEY;
  const geminiKey = process.env.GOOGLE_AI_KEY;

  // Prefer HF FLUX (faster, free tier)
  if (hfToken) {
    try {
      return await generateViaHuggingFace(prompt, hfToken);
    } catch (err: any) {
      console.warn("[Image] HF failed, trying Gemini fallback:", err.message);
      if (geminiKey) {
        return await generateViaGemini(prompt, geminiKey);
      }
      throw err;
    }
  }

  // Fall back to Gemini
  if (geminiKey) {
    return await generateViaGemini(prompt, geminiKey);
  }

  throw new Error(
    "Image generation is not configured. Add HUGGINGFACE_API_KEY (free at huggingface.co) or enable billing on your Google AI Studio account.",
  );
}
