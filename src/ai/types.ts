export interface JsonLlmClient {
  provider: "cerebras" | "openai" | "unknown";
  model: string;
  call: (opts: {
    systemPrompt: string;
    userPrompt: string;
    jsonMode?: boolean;
    timeoutMs?: number;
    temperature?: number;
  }) => Promise<any | null>;
}
