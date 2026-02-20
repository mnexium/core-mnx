import type { CoreStore } from "../contracts/storage";
import type { Memory } from "../contracts/types";
import type { CerebrasClient } from "../providers/cerebras";
import type { JsonLlmClient } from "./types";

const CLASSIFY_TIMEOUT_MS = 2000;
const RERANK_TIMEOUT_MS = 3000;

export type RecallMode = "broad" | "direct" | "indirect" | "simple";

type ScoredMemory = Memory & {
  score: number;
  effective_score: number;
};

export interface RecallService {
  name: string;
  search(args: {
    project_id: string;
    subject_id: string;
    query: string;
    limit: number;
    min_score: number;
    conversation_context?: string[];
  }): Promise<{
    memories: ScoredMemory[];
    mode: RecallMode;
    used_queries: string[];
    predicates: string[];
  }>;
}

export interface CreateLLMRecallServiceOptions {
  store: CoreStore;
  llm: JsonLlmClient;
  embed: (text: string) => Promise<number[]>;
}

export interface CreateSimpleRecallServiceOptions {
  store: CoreStore;
  embed?: (text: string) => Promise<number[]>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v || "").trim())
    .filter(Boolean);
}

function scoreNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return Math.floor(v);
}

function dedupeQueries(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

function toIso(value: unknown): string {
  const s = String(value || "");
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return new Date(0).toISOString();
  return d.toISOString();
}

async function classifyRecallQuery(params: {
  llm: JsonLlmClient;
  query: string;
  conversationContext: string[];
}): Promise<{
  mode: Exclude<RecallMode, "simple">;
  predicates: string[];
  searchHints: string[];
  expandedQueries: string[];
}> {
  const contextBlock = params.conversationContext.length
    ? `\nRecent conversation:\n${params.conversationContext
        .map((m, i) => `${i + 1}. ${m}`)
        .join("\n")}\n`
    : "";

  const systemPrompt = `You are a memory retrieval router.
Classify a user query into:
- broad: asks for overall summary/profile
- direct: asks for specific personal fact
- indirect: asks for advice where personal context helps

Also extract:
- predicates: structured fields likely needed (0-3)
- search_hints: short keyword phrases (1-3)
- expanded_queries: only for indirect mode (0-3)

Return strict JSON:
{
  "mode":"broad|direct|indirect",
  "predicates":["..."],
  "search_hints":["..."],
  "expanded_queries":["..."]
}`;

  const userPrompt = `${contextBlock}User message: "${params.query}"`;

  try {
    const result = await params.llm.call({
      systemPrompt,
      userPrompt,
      jsonMode: true,
      timeoutMs: CLASSIFY_TIMEOUT_MS,
    });
    const mode: Exclude<RecallMode, "simple"> =
      result?.mode === "broad" || result?.mode === "direct" || result?.mode === "indirect"
        ? result.mode
        : "indirect";
    return {
      mode,
      predicates: asStringArray(result?.predicates).slice(0, 3),
      searchHints: asStringArray(result?.search_hints).slice(0, 3),
      expandedQueries: asStringArray(result?.expanded_queries).slice(0, 3),
    };
  } catch {
    return {
      mode: "indirect",
      predicates: [],
      searchHints: [],
      expandedQueries: [],
    };
  }
}

async function rerankMemories(params: {
  llm: JsonLlmClient;
  query: string;
  conversationContext: string[];
  candidates: ScoredMemory[];
  topK: number;
}): Promise<ScoredMemory[]> {
  if (params.candidates.length === 0) return [];
  const filtered = params.candidates.filter((m) => String(m.text || "").trim().length >= 10);
  if (filtered.length === 0) return [];
  if (filtered.length <= params.topK) return filtered;
  const contextBlock = params.conversationContext.length
    ? `\nRecent conversation:\n${params.conversationContext
        .map((m, i) => `${i + 1}. ${m}`)
        .join("\n")}\n`
    : "";

  const memories = filtered.map((m, i) => `[${i}] ${m.text}`).join("\n");
  const systemPrompt = `You are a memory relevance judge.
Given a user query and candidate memories, select relevant memories and rank them.
Return strict JSON:
{
  "ranked": [
    { "index": 0, "relevant": true, "score": 0.92 }
  ]
}
Rules:
- Keep only relevant=true entries.
- score is 0..1.
- Return at most ${params.topK} entries.`;
  const userPrompt = `${contextBlock}User query: "${params.query}"\n\nCandidates:\n${memories}`;

  try {
    const result = await params.llm.call({
      systemPrompt,
      userPrompt,
      jsonMode: true,
      timeoutMs: RERANK_TIMEOUT_MS,
    });
    const ranked = Array.isArray(result?.ranked) ? result.ranked : [];
    const selected: Array<{ idx: number; score: number }> = [];
    for (const item of ranked) {
      const idx = Number(item?.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= filtered.length) continue;
      if (item?.relevant !== true) continue;
      selected.push({ idx, score: scoreNum(item?.score, 0.5) });
    }
    if (selected.length === 0) return [];
    selected.sort((a, b) => b.score - a.score);
    return selected.slice(0, params.topK).map((row) => {
      const base = filtered[row.idx];
      const rerankScore = row.score * 100;
      return {
        ...base,
        effective_score: Math.max(base.effective_score, rerankScore),
        score: Math.max(base.score, rerankScore),
      };
    });
  } catch {
    return filtered.slice(0, params.topK);
  }
}

export function createLLMRecallService(options: CreateLLMRecallServiceOptions): RecallService {
  const { store, llm, embed } = options;

  return {
    name: `${llm.provider}:${llm.model}`,
    async search(args) {
      const query = String(args.query || "").trim();
      const limit = clampInt(args.limit || 25, 1, 200);
      const minScore = Number.isFinite(Number(args.min_score)) ? Number(args.min_score) : 30;
      const conversationContext = Array.isArray(args.conversation_context)
        ? args.conversation_context.map((v) => String(v || "")).filter(Boolean).slice(-5)
        : [];

      if (!query) {
        return {
          memories: [],
          mode: "indirect",
          used_queries: [],
          predicates: [],
        };
      }

      const classified = await classifyRecallQuery({
        llm,
        query,
        conversationContext,
      });

      if (classified.mode === "broad") {
        const rows = await store.listMemories({
          project_id: args.project_id,
          subject_id: args.subject_id,
          limit: Math.min(limit * 3, 200),
          offset: 0,
          include_deleted: false,
          include_superseded: false,
        });
        const sorted = [...rows].sort((a, b) => {
          const imp = Number(b.importance) - Number(a.importance);
          if (imp !== 0) return imp;
          return toIso(b.created_at).localeCompare(toIso(a.created_at));
        });
        const broadLimit = Math.max(limit, 20);
        const memories: ScoredMemory[] = sorted.slice(0, broadLimit).map((m) => ({
          ...m,
          score: 100,
          effective_score: Number(m.importance || 0),
        }));
        return {
          memories,
          mode: "broad",
          used_queries: [query],
          predicates: classified.predicates,
        };
      }

      const queries = dedupeQueries([
        query,
        ...classified.searchHints,
        ...(classified.mode === "indirect" ? classified.expandedQueries : []),
      ]).slice(0, 6);

      const allResults: Array<{
        q: string;
        rank: number;
        rows: ScoredMemory[];
      }> = [];

      const searches = queries.map(async (q, rank) => {
        let embedding: number[] | null = null;
        try {
          const emb = await embed(q);
          embedding = Array.isArray(emb) && emb.length > 0 ? emb : null;
        } catch {
          embedding = null;
        }
        const rows = await store.searchMemories({
          project_id: args.project_id,
          subject_id: args.subject_id,
          q,
          query_embedding: embedding,
          limit: Math.min(limit * 2, 200),
          min_score: minScore,
        });
        allResults.push({
          q,
          rank,
          rows: rows as ScoredMemory[],
        });
      });

      await Promise.all(searches);

      if (classified.mode === "direct" && classified.predicates.length > 0) {
        const truth = await store.getCurrentTruth({
          project_id: args.project_id,
          subject_id: args.subject_id,
        });
        const sourceMemoryIds = truth
          .filter((row) => classified.predicates.includes(String(row.predicate)))
          .map((row) => row.source_memory_id)
          .filter((id): id is string => !!id);
        const uniqueIds = [...new Set(sourceMemoryIds)];
        for (const memoryId of uniqueIds) {
          const mem = await store.getMemory({
            project_id: args.project_id,
            id: memoryId,
          });
          if (!mem || mem.is_deleted || mem.status !== "active") continue;
          allResults.push({
            q: "__claims__",
            rank: 0,
            rows: [
              {
                ...mem,
                score: 100,
                effective_score: 120,
              },
            ],
          });
        }
      }

      const byId = new Map<string, ScoredMemory>();
      for (const group of allResults) {
        for (const row of group.rows) {
          const qBoost = group.rank === 0 ? 1 : 1 - group.rank * 0.03;
          const boosted: ScoredMemory = {
            ...row,
            score: scoreNum(row.score, 0) * qBoost,
            effective_score: scoreNum(row.effective_score, 0) * qBoost,
          };
          const existing = byId.get(row.id);
          if (!existing || boosted.effective_score > existing.effective_score) {
            byId.set(row.id, boosted);
          }
        }
      }

      let candidates = [...byId.values()].sort((a, b) => b.effective_score - a.effective_score);

      if (classified.mode === "direct") {
        const hasClaimResults = allResults.some((group) => group.q === "__claims__" && group.rows.length > 0);
        if (hasClaimResults) {
          const directLimit = Math.min(limit, 5);
          candidates = candidates
            .sort((a, b) => b.effective_score - a.effective_score)
            .slice(0, directLimit);
        } else if (candidates.length > limit) {
          candidates = await rerankMemories({
            llm,
            query,
            conversationContext,
            candidates,
            topK: limit,
          });
        } else {
          const directLimit = Math.min(limit, 5);
          candidates = candidates
            .sort((a, b) => b.effective_score - a.effective_score)
            .slice(0, directLimit);
        }
      } else if (candidates.length > limit) {
        candidates = await rerankMemories({
          llm,
          query,
          conversationContext,
          candidates,
          topK: limit,
        });
      } else {
        candidates = candidates.slice(0, limit);
      }

      return {
        memories: candidates.slice(0, limit),
        mode: classified.mode,
        used_queries: queries,
        predicates: classified.predicates,
      };
    },
  };
}

export function createSimpleRecallService(options: CreateSimpleRecallServiceOptions): RecallService {
  const { store, embed } = options;
  return {
    name: "simple",
    async search(args) {
      const query = String(args.query || "").trim();
      const limit = clampInt(args.limit || 25, 1, 200);
      const minScore = Number.isFinite(Number(args.min_score)) ? Number(args.min_score) : 30;
      let embedding: number[] | null = null;
      if (embed) {
        try {
          const emb = await embed(query);
          embedding = Array.isArray(emb) && emb.length > 0 ? emb : null;
        } catch {
          embedding = null;
        }
      }

      const memories = (await store.searchMemories({
        project_id: args.project_id,
        subject_id: args.subject_id,
        q: query,
        query_embedding: embedding,
        limit,
        min_score: minScore,
      })) as ScoredMemory[];

      return {
        memories,
        mode: "simple",
        used_queries: [query],
        predicates: [],
      };
    },
  };
}

// Compatibility helper to preserve previous import path.
export function createCerebrasRecallService(options: {
  store: CoreStore;
  cerebras: CerebrasClient;
  embed: (text: string) => Promise<number[]>;
}): RecallService {
  return createLLMRecallService({
    store: options.store,
    llm: options.cerebras as unknown as JsonLlmClient,
    embed: options.embed,
  });
}
