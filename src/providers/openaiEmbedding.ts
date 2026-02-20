const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";

let warnedMissingKey = false;

export interface OpenAIEmbedderOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Returns a text->embedding function backed by OpenAI embeddings.
 * If no API key is configured, it safely returns an empty embedding.
 */
export function createOpenAIEmbedder(options: OpenAIEmbedderOptions = {}) {
  const apiKey = String(options.apiKey || process.env.OPENAI_API_KEY || "").trim();
  const model = String(options.model || process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small").trim();

  return async function embed(text: string): Promise<number[]> {
    const input = String(text || "").trim();
    if (!input) return [];

    if (!apiKey) {
      if (!warnedMissingKey) {
        warnedMissingKey = true;
        console.warn("[core] OPENAI_API_KEY not set; embedding-enabled routes will fall back to non-vector behavior.");
      }
      return [];
    }

    const res = await fetch(OPENAI_EMBED_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`openai_embedding_failed: ${res.status} ${errText}`);
    }

    const json: any = await res.json();
    const embedding = json?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) return [];
    return embedding.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v));
  };
}
