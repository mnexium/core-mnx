import "dotenv/config";
import { Pool } from "pg";
import { createCoreServer } from "./server/createCoreServer";
import { PostgresCoreStore } from "./adapters/postgres/PostgresCoreStore";
import { createOpenAIEmbedder } from "./providers/openaiEmbedding";
import { createCerebrasClient } from "./providers/cerebras";
import { createOpenAIChatClient } from "./providers/openaiChat";
import { createLLMRecallService, createSimpleRecallService } from "./ai/recallService";
import { createLLMMemoryExtractionService, createSimpleMemoryExtractionService } from "./ai/memoryExtractionService";
import type { JsonLlmClient } from "./ai/types";

function envFlag(raw: string | undefined, fallback = false): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function toErrorMessage(err: unknown): string {
  if (!err) return "unknown_error";
  if (typeof err === "string") return err;
  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length > 0) {
    return `AggregateError: ${err.errors.map((e) => toErrorMessage(e)).join(" | ")}`;
  }
  if (typeof err === "object" && err && Array.isArray((err as any).errors) && (err as any).errors.length > 0) {
    return `AggregateError: ${(err as any).errors.map((e: unknown) => toErrorMessage(e)).join(" | ")}`;
  }
  if (typeof err === "object" && err && (err as any).cause) {
    return `${String((err as any).message || err)} (cause: ${toErrorMessage((err as any).cause)})`;
  }
  return String((err as any)?.message || err);
}

const required = ["POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing env var: ${key}`);
  }
}

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

const store = new PostgresCoreStore(pool);
const embed = createOpenAIEmbedder({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small",
});

const configuredAiMode = String(process.env.CORE_AI_MODE || "auto").trim().toLowerCase();
const cerebrasApiKey = String(process.env.CEREBRAS_API || "").trim();
const openaiApiKey = String(process.env.OPENAI_API_KEY || "").trim();
const retrievalModel = String(process.env.RETRIEVAL_MODEL || "").trim();
const useRetrievalExpand = envFlag(process.env.USE_RETRIEVAL_EXPAND, true);
const debugEnabled = envFlag(process.env.CORE_DEBUG, false);

let llmClient: JsonLlmClient | null = null;
let resolvedAiMode: "cerebras" | "openai" | "simple" = "simple";

const wantCerebras = configuredAiMode === "cerebras" || configuredAiMode === "auto";
const wantOpenAI = configuredAiMode === "openai" || configuredAiMode === "auto";
const wantSimple = configuredAiMode === "simple";

if (wantCerebras && cerebrasApiKey) {
  llmClient = createCerebrasClient({
    apiKey: cerebrasApiKey,
    model: retrievalModel || "gpt-oss-120b",
  });
  resolvedAiMode = "cerebras";
} else if (wantOpenAI && openaiApiKey) {
  llmClient = createOpenAIChatClient({
    apiKey: openaiApiKey,
    model: retrievalModel || "gpt-4o-mini",
  });
  resolvedAiMode = "openai";
} else if (wantSimple || configuredAiMode === "auto") {
  llmClient = null;
  resolvedAiMode = "simple";
}

if (configuredAiMode === "cerebras" && !cerebrasApiKey) {
  console.warn("[core] CORE_AI_MODE=cerebras but CEREBRAS_API is missing; falling back to simple mode.");
}
if (configuredAiMode === "openai" && !openaiApiKey) {
  console.warn("[core] CORE_AI_MODE=openai but OPENAI_API_KEY is missing; falling back to simple mode.");
}

const recallService = llmClient
  ? (useRetrievalExpand
      ? createLLMRecallService({
          store,
          embed,
          llm: llmClient,
        })
      : createSimpleRecallService({
          store,
          embed,
        }))
  : createSimpleRecallService({
      store,
      embed,
    });

const memoryExtractionService = llmClient
  ? createLLMMemoryExtractionService({
      llm: llmClient,
    })
  : createSimpleMemoryExtractionService();

const server = createCoreServer({
  store,
  defaultProjectId: process.env.CORE_DEFAULT_PROJECT_ID || "default-project",
  embed,
  recallService,
  memoryExtractionService,
  debug: debugEnabled,
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  const model = llmClient?.model ? ` (${llmClient.provider}:${llmClient.model})` : "";
  console.log(
    `[core] postgres target: ${process.env.POSTGRES_HOST}:${Number(process.env.POSTGRES_PORT || 5432)}/${process.env.POSTGRES_DB} user=${process.env.POSTGRES_USER}`,
  );
  console.log(`[core] ai mode: ${resolvedAiMode}${model}`);
  console.log(`[core] retrieval expand: ${useRetrievalExpand ? "enabled" : "disabled (simple mode)"}`);
  console.log(`[core] debug: ${debugEnabled ? "enabled" : "disabled"}`);
  console.log(`[core] listening on http://localhost:${port}`);
});

void pool
  .query("select 1 as ok")
  .then(() => {
    console.log("[core] postgres connectivity check: ok");
  })
  .catch((err) => {
    console.warn(`[core] postgres connectivity check failed: ${toErrorMessage(err)}`);
  });
