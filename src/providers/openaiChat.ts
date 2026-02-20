const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4o-mini";

export interface OpenAIChatClientOptions {
  apiKey?: string;
  model?: string;
}

export interface OpenAIChatClient {
  provider: "openai";
  model: string;
  callRaw: (opts: {
    systemPrompt: string;
    userPrompt: string;
    jsonMode?: boolean;
    timeoutMs?: number;
    temperature?: number;
  }) => Promise<any>;
  call: (opts: {
    systemPrompt: string;
    userPrompt: string;
    jsonMode?: boolean;
    timeoutMs?: number;
    temperature?: number;
  }) => Promise<any | null>;
}

export function createOpenAIChatClient(options: OpenAIChatClientOptions = {}): OpenAIChatClient {
  const apiKey = String(options.apiKey || process.env.OPENAI_API_KEY || "").trim();
  const model = String(options.model || process.env.RETRIEVAL_MODEL || DEFAULT_MODEL).trim();

  async function callRaw(opts: {
    systemPrompt: string;
    userPrompt: string;
    jsonMode?: boolean;
    timeoutMs?: number;
    temperature?: number;
  }): Promise<any> {
    if (!apiKey) {
      throw new Error("[core:openai] OPENAI_API_KEY env var is not set");
    }

    const body: Record<string, unknown> = {
      model,
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: String(opts.systemPrompt || "") }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: String(opts.userPrompt || "") }],
        },
      ],
      store: false,
      reasoning: { effort: "minimal" },
      temperature: Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0,
    };

    if (opts.jsonMode !== false) {
      body.text = { format: { type: "json_object" } };
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

    const res = await fetch(OPENAI_RESPONSES_URL, fetchOptions);
    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`[core:openai] API error: ${res.status} - ${errorText}`);
    }
    return res.json();
  }

  async function call(opts: {
    systemPrompt: string;
    userPrompt: string;
    jsonMode?: boolean;
    timeoutMs?: number;
    temperature?: number;
  }): Promise<any | null> {
    const raw = await callRaw(opts);

    const outputItem = Array.isArray(raw?.output)
      ? raw.output.find((o: any) => o?.type === "message" && o?.role === "assistant")
      : null;
    const textContent = Array.isArray(outputItem?.content)
      ? outputItem.content.find((c: any) => c?.type === "output_text")
      : null;

    const content = String(textContent?.text || raw?.output_text || "").trim();
    if (!content) return null;

    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  return {
    provider: "openai",
    model,
    callRaw,
    call,
  };
}
