import type { CerebrasClient } from "../providers/cerebras";
import type { JsonLlmClient } from "./types";

export interface ExtractedClaim {
  predicate: string;
  object_value: string;
  claim_type?: string;
  confidence?: number;
}

export interface ExtractedMemory {
  text: string;
  kind: "fact" | "preference" | "context" | "note" | "event" | "trait";
  importance: number;
  confidence: number;
  is_temporal: boolean;
  visibility: "private" | "shared" | "public";
  tags: string[];
  claims: ExtractedClaim[];
}

export interface MemoryExtractionResult {
  memories: ExtractedMemory[];
}

export interface MemoryExtractionService {
  name: string;
  extract(args: {
    subject_id: string;
    text: string;
    force?: boolean;
    conversation_context?: string[];
  }): Promise<MemoryExtractionResult>;
}

export interface CreateLLMMemoryExtractionServiceOptions {
  llm: JsonLlmClient;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || "").trim()).filter(Boolean);
}

function normalizeKind(value: unknown): ExtractedMemory["kind"] {
  const v = String(value || "").toLowerCase().trim();
  if (v === "fact" || v === "preference" || v === "context" || v === "note" || v === "event" || v === "trait") {
    return v;
  }
  return "fact";
}

function normalizeVisibility(value: unknown): ExtractedMemory["visibility"] {
  const v = String(value || "").toLowerCase().trim();
  if (v === "private" || v === "shared" || v === "public") return v;
  return "private";
}

function normalizeClaim(raw: unknown): ExtractedClaim | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const predicate = String(obj.predicate || "").trim();
  const objectValue = String(obj.object_value || "").trim();
  if (!predicate || !objectValue) return null;
  const out: ExtractedClaim = {
    predicate,
    object_value: objectValue,
  };
  const claimType = String(obj.claim_type || "").trim();
  if (claimType) out.claim_type = claimType;
  const confidence = Number(obj.confidence);
  if (Number.isFinite(confidence)) out.confidence = Math.max(0, Math.min(1, confidence));
  return out;
}

function normalizeMemory(raw: unknown): ExtractedMemory | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const text = String(obj.text || "").trim();
  if (!text) return null;
  const claimsRaw = Array.isArray(obj.claims) ? obj.claims : [];
  const claims = claimsRaw.map(normalizeClaim).filter((v): v is ExtractedClaim => !!v);
  return {
    text,
    kind: normalizeKind(obj.kind),
    importance: asNumber(obj.importance, 50, 0, 100),
    confidence: asNumber(obj.confidence, 0.8, 0, 1),
    is_temporal: asBool(obj.is_temporal, false),
    visibility: normalizeVisibility(obj.visibility),
    tags: asStringArray(obj.tags),
    claims,
  };
}

function normalizePredicate(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

function buildSimpleClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const push = (predicate: string, value: string, claimType = "fact", confidence = 0.65) => {
    const p = normalizePredicate(predicate);
    const v = String(value || "").trim();
    if (!p || !v) return;
    const key = `${p}::${v.toLowerCase()}`;
    if (claims.some((c) => `${c.predicate}::${c.object_value.toLowerCase()}` === key)) return;
    claims.push({
      predicate: p,
      object_value: v,
      claim_type: claimType,
      confidence,
    });
  };

  const patterns: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [/my name is\s+([^.,!?\n]+)/i, (m) => push("name", m[1], "fact", 0.9)],
    [/i live in\s+([^.,!?\n]+)/i, (m) => push("lives_in", m[1], "fact", 0.85)],
    [/i work at\s+([^.,!?\n]+)/i, (m) => push("works_at", m[1], "fact", 0.85)],
    [/my favorite\s+([a-zA-Z ]+)\s+is\s+([^.,!?\n]+)/i, (m) => push(`favorite_${m[1]}`, m[2], "preference", 0.85)],
    [/i like\s+([^.,!?\n]+)/i, (m) => push("likes", m[1], "preference", 0.7)],
  ];

  for (const [pattern, handler] of patterns) {
    const match = text.match(pattern);
    if (match) handler(match);
  }

  return claims;
}

function simpleExtract(args: {
  text: string;
  force?: boolean;
}): MemoryExtractionResult {
  const text = String(args.text || "").trim().replace(/\s+/g, " ");
  if (!text) return { memories: [] };

  const lower = text.toLowerCase();
  const trivial =
    /^(ok|thanks|thank you|cool|nice|yes|no|yep|nope|hi|hello|hey)\b/.test(lower) &&
    text.length < 40;

  if (trivial && !args.force) {
    return { memories: [] };
  }

  const claims = buildSimpleClaims(text);
  return {
    memories: [
      {
        text: text.slice(0, 2000),
        kind: claims.length > 0 ? "fact" : "note",
        importance: args.force ? 70 : 50,
        confidence: claims.length > 0 ? 0.75 : 0.6,
        is_temporal: false,
        visibility: "private",
        tags: ["simple_mode"],
        claims,
      },
    ],
  };
}

export function createLLMMemoryExtractionService(
  options: CreateLLMMemoryExtractionServiceOptions,
): MemoryExtractionService {
  const { llm } = options;

  return {
    name: `${llm.provider}:${llm.model}`,
    async extract(args) {
      const text = String(args.text || "").trim();
      if (!text) return { memories: [] };

      const force = args.force === true;
      const contextBlock = Array.isArray(args.conversation_context) && args.conversation_context.length > 0
        ? `\nRecent conversation:\n${args.conversation_context.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n`
        : "";

      const systemPrompt = `You extract durable user memories from chat text.
Return strict JSON:
{
  "memories": [
    {
      "text": "string",
      "kind": "fact|preference|context|note|event|trait",
      "importance": 0-100,
      "confidence": 0-1,
      "is_temporal": true|false,
      "visibility": "private|shared|public",
      "tags": ["string"],
      "claims": [
        {
          "predicate": "string",
          "object_value": "string",
          "claim_type": "string",
          "confidence": 0-1
        }
      ]
    }
  ]
}

Rules:
- Prefer durable, user-specific memories.
- Keep memory text concise and factual.
- Use empty list when no durable memory exists.
- If force=true, return at least one memory if possible.`;

      const userPrompt = `${contextBlock}subject_id=${args.subject_id}\nforce=${force}\ntext:\n${text}`;

      try {
        const result = await llm.call({
          systemPrompt,
          userPrompt,
          jsonMode: true,
          timeoutMs: 4000,
        });
        const memoriesRaw = Array.isArray(result?.memories) ? result.memories : [];
        const memories = memoriesRaw.map(normalizeMemory).filter((v): v is ExtractedMemory => !!v);
        if (memories.length > 0) return { memories };
      } catch {
        // Fall through to simple extraction fallback.
      }

      return simpleExtract({ text, force });
    },
  };
}

export function createSimpleMemoryExtractionService(): MemoryExtractionService {
  return {
    name: "simple",
    async extract(args) {
      return simpleExtract(args);
    },
  };
}

// Compatibility helper to preserve previous import path.
export function createCerebrasMemoryExtractionService(options: {
  cerebras: CerebrasClient;
}): MemoryExtractionService {
  return createLLMMemoryExtractionService({
    llm: options.cerebras as unknown as JsonLlmClient,
  });
}
