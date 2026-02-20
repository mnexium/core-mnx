const CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions";
const DEFAULT_MODEL = "gpt-oss-120b";

export interface CerebrasClientOptions {
  apiKey?: string;
  model?: string;
}

export interface CerebrasCallOptions {
  systemPrompt: string;
  userPrompt: string;
  jsonMode?: boolean;
  timeoutMs?: number;
  temperature?: number;
}

export interface CerebrasClient {
  provider: "cerebras";
  callRaw: (opts: {
    messages: Array<{ role: string; content: string }>;
    jsonMode?: boolean;
    timeoutMs?: number;
    temperature?: number;
  }) => Promise<any>;
  call: (opts: CerebrasCallOptions) => Promise<any | null>;
  model: string;
}

export function createCerebrasClient(options: CerebrasClientOptions = {}): CerebrasClient {
  const apiKey = String(options.apiKey || process.env.CEREBRAS_API || "").trim();
  const model = String(options.model || process.env.RETRIEVAL_MODEL || DEFAULT_MODEL).trim();

  async function callRaw(opts: {
    messages: Array<{ role: string; content: string }>;
    jsonMode?: boolean;
    timeoutMs?: number;
    temperature?: number;
  }): Promise<any> {
    if (!apiKey) {
      throw new Error("[core:cerebras] CEREBRAS_API env var is not set");
    }

    const body: Record<string, unknown> = {
      model,
      stream: false,
      messages: opts.messages,
      temperature: Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0,
      max_tokens: -1,
      seed: 0,
      top_p: 1,
    };
    if (opts.jsonMode !== false) {
      body.response_format = { type: "json_object" };
    }

    const fetchOptions: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };
    if (opts.timeoutMs && typeof AbortSignal.timeout === "function") {
      fetchOptions.signal = AbortSignal.timeout(opts.timeoutMs);
    }

    const res = await fetch(CEREBRAS_API_URL, fetchOptions);
    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`[core:cerebras] API error: ${res.status} - ${errorText}`);
    }
    return res.json();
  }

  async function call(opts: CerebrasCallOptions): Promise<any | null> {
    const raw = await callRaw({
      messages: [
        { role: "system", content: String(opts.systemPrompt || "") },
        { role: "user", content: String(opts.userPrompt || "") },
      ],
      jsonMode: opts.jsonMode !== false,
      timeoutMs: opts.timeoutMs,
      temperature: opts.temperature,
    });

    const content = raw?.choices?.[0]?.message?.content || "";
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  return {
    provider: "cerebras",
    callRaw,
    call,
    model,
  };
}
