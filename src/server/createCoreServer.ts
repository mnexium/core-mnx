import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { randomUUID } from "crypto";
import type { CoreStore } from "../contracts/storage";
import { MemoryEventBus } from "./memoryEventBus";
import type { RecallService } from "../ai/recallService";
import { createSimpleMemoryExtractionService, type MemoryExtractionService } from "../ai/memoryExtractionService";

export interface CreateCoreServerOptions {
  store: CoreStore;
  defaultProjectId?: string;
  resolveProjectId?: (req: IncomingMessage) => Promise<string | null> | string | null;
  embed?: (text: string) => Promise<number[]>;
  recallService?: RecallService;
  memoryExtractionService?: MemoryExtractionService;
  debug?: boolean;
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBool(raw: string | null, fallback = false): boolean {
  if (raw == null) return fallback;
  return String(raw).toLowerCase() === "true";
}

function parseIntInRange(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, any> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeProjectId(headerValue: string | string[] | undefined, fallback?: string): string | null {
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const projectId = String(header || fallback || "").trim();
  return projectId || null;
}

async function resolveProjectId(req: IncomingMessage, options: CreateCoreServerOptions): Promise<string | null> {
  if (options.resolveProjectId) {
    const projectId = await options.resolveProjectId(req);
    const normalized = String(projectId || "").trim();
    if (normalized) return normalized;
  }
  return normalizeProjectId(req.headers["x-project-id"], options.defaultProjectId);
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeMemoryForApi(memory: Record<string, any>): Record<string, unknown> {
  const { embedding: _embedding, is_deleted: _isDeleted, ...rest } = memory || {};
  return rest;
}

function mapMemorySearchResult(memory: Record<string, any>): Record<string, unknown> {
  return {
    id: memory.id,
    text: memory.text,
    kind: memory.kind,
    importance: memory.importance,
    is_temporal: memory.is_temporal,
    created_at: memory.created_at,
    score: Number(memory.score) || 0,
    effective_score: Number(memory.effective_score) || 0,
  };
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

export function createCoreServer(options: CreateCoreServerOptions): Server {
  const bus = new MemoryEventBus();
  const extractionService = options.memoryExtractionService || createSimpleMemoryExtractionService();
  const debugEnabled = options.debug === true;

  function debugLog(message: string, meta?: Record<string, unknown>) {
    if (!debugEnabled) return;
    const ts = new Date().toISOString();
    if (meta) {
      console.log(`[core][debug][${ts}] ${message}`, meta);
      return;
    }
    console.log(`[core][debug][${ts}] ${message}`);
  }

  return createServer(async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    const startedAt = Date.now();

    debugLog("request.start", {
      method,
      path,
      query: url.searchParams.toString(),
      hasProjectHeader: !!req.headers["x-project-id"],
    });

    if (method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, service: "mnexium-core", timestamp: new Date().toISOString() });
      debugLog("request.end", { method, path, status: 200, duration_ms: Date.now() - startedAt });
      return;
    }

    const projectId = await resolveProjectId(req, options);
    if (!projectId) {
      sendJson(res, 400, { error: "project_id_required", message: "Provide x-project-id header or configure defaultProjectId" });
      debugLog("request.end", { method, path, status: 400, error: "project_id_required", duration_ms: Date.now() - startedAt });
      return;
    }
    debugLog("project.resolved", { projectId, method, path });

    try {
      // ------------------------------------------------------------------
      // SSE Events
      // ------------------------------------------------------------------
      if (method === "GET" && path === "/api/v1/events/memories") {
        const subjectId = String(url.searchParams.get("subject_id") || "").trim() || null;
        debugLog("sse.subscribe", { projectId, subjectId });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        const writeSse = (eventType: string, data: Record<string, unknown>) => {
          res.write(`event: ${eventType}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        writeSse("connected", {
          project_id: projectId,
          subject_id: subjectId,
          timestamp: new Date().toISOString(),
        });

        const unsubscribe = bus.subscribe(projectId, subjectId, (event) => {
          writeSse(event.type, event.data);
        });

        const heartbeat = setInterval(() => {
          writeSse("heartbeat", { timestamp: new Date().toISOString() });
        }, 30000);

        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
          debugLog("sse.unsubscribe", { projectId, subjectId });
        });
        return;
      }

      // ------------------------------------------------------------------
      // Memories
      // ------------------------------------------------------------------
      if (method === "GET" && path === "/api/v1/memories") {
        const subjectId = String(url.searchParams.get("subject_id") || "").trim();
        if (!subjectId) {
          sendJson(res, 400, { error: "subject_id_required" });
          return;
        }
        const limit = parseIntInRange(url.searchParams.get("limit"), 50, 1, 200);
        const offset = parseIntInRange(url.searchParams.get("offset"), 0, 0, 1_000_000);
        const includeDeleted = parseBool(url.searchParams.get("include_deleted"), false);
        const includeSuperseded = parseBool(url.searchParams.get("include_superseded"), false);
        const data = await options.store.listMemories({
          project_id: projectId,
          subject_id: subjectId,
          limit,
          offset,
          include_deleted: includeDeleted,
          include_superseded: includeSuperseded,
        });
        const sanitized = data.map((m) => sanitizeMemoryForApi(m as unknown as Record<string, any>));
        sendJson(res, 200, { data: sanitized, count: sanitized.length });
        return;
      }

      if (method === "POST" && path === "/api/v1/memories/extract") {
        const body = await readJsonBody(req);
        if (!body) {
          sendJson(res, 400, { error: "invalid_json_body" });
          return;
        }
        const subjectId = String(body.subject_id || "").trim();
        const text = String(body.text || "").trim();
        if (!subjectId) {
          sendJson(res, 400, { error: "subject_id_required" });
          return;
        }
        if (!text) {
          sendJson(res, 400, { error: "text_required" });
          return;
        }
        const learn = body.learn === true || parseBool(url.searchParams.get("learn"), false);
        const force = body.force === true || parseBool(url.searchParams.get("force"), false);
        const context = Array.isArray(body.conversation_context)
          ? body.conversation_context.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(-5)
          : [];

        const extracted = await extractionService.extract({
          subject_id: subjectId,
          text,
          force,
          conversation_context: context,
        });
        debugLog("memories.extract", {
          mode: extractionService.name,
          learn,
          extracted_count: extracted.memories.length,
          subjectId,
        });

        if (!learn) {
          sendJson(res, 200, {
            ok: true,
            learned: false,
            mode: extractionService.name,
            extracted_count: extracted.memories.length,
            memories: extracted.memories,
          });
          debugLog("request.end", { method, path, status: 200, mode: extractionService.name, duration_ms: Date.now() - startedAt });
          return;
        }

        const learnedMemories: Array<Record<string, unknown>> = [];
        let learnedClaims = 0;
        for (const mem of extracted.memories) {
          let embedding: number[] | null = null;
          if (options.embed) {
            try {
              embedding = await options.embed(mem.text);
            } catch {
              embedding = null;
            }
          }
          const memoryId = `mem_${randomUUID()}`;
          const created = await options.store.createMemory({
            id: memoryId,
            project_id: projectId,
            subject_id: subjectId,
            text: mem.text,
            kind: mem.kind,
            visibility: mem.visibility,
            importance: mem.importance,
            confidence: mem.confidence,
            is_temporal: mem.is_temporal,
            tags: mem.tags,
            metadata: {
              extracted_via: extractionService.name,
              force,
            },
            source_type: "inferred",
            embedding,
          });

          bus.emit(projectId, subjectId, "memory.created", {
            id: created.id,
            subject_id: created.subject_id,
            text: created.text,
            kind: created.kind,
            visibility: created.visibility,
            importance: created.importance,
            tags: created.tags,
            created_at: created.created_at,
          });

          const createdClaimIds: string[] = [];
          for (const claim of mem.claims) {
            const claimId = `clm_${randomUUID()}`;
            let claimEmbedding: number[] | null = null;
            if (options.embed) {
              try {
                claimEmbedding = await options.embed(`${claim.predicate}: ${claim.object_value}`);
              } catch {
                claimEmbedding = null;
              }
            }
            const createdClaim = await options.store.createClaim({
              claim_id: claimId,
              project_id: projectId,
              subject_id: subjectId,
              predicate: claim.predicate,
              object_value: claim.object_value,
              claim_type: claim.claim_type,
              confidence: claim.confidence,
              source_memory_id: memoryId,
              embedding: claimEmbedding,
            });
            createdClaimIds.push(createdClaim.claim_id);
            learnedClaims++;
          }

          learnedMemories.push({
            memory_id: created.id,
            text: created.text,
            kind: created.kind,
            claim_ids: createdClaimIds,
          });
        }

        sendJson(res, 200, {
          ok: true,
          mode: extractionService.name,
          learned: true,
          extracted_count: extracted.memories.length,
          learned_memory_count: learnedMemories.length,
          learned_claim_count: learnedClaims,
          memories: learnedMemories,
        });
        debugLog("request.end", {
          method,
          path,
          status: 200,
          mode: extractionService.name,
          learned_memory_count: learnedMemories.length,
          learned_claim_count: learnedClaims,
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      if (method === "GET" && path === "/api/v1/memories/search") {
        const subjectId = String(url.searchParams.get("subject_id") || "").trim();
        const q = String(url.searchParams.get("q") || "").trim();
        if (!subjectId) {
          sendJson(res, 400, { error: "subject_id_required" });
          return;
        }
        if (!q) {
          sendJson(res, 400, { error: "q_required" });
          return;
        }
        const limit = parseIntInRange(url.searchParams.get("limit"), 25, 1, 200);
        const minScore = Number(url.searchParams.get("min_score") ?? url.searchParams.get("distance") ?? "30");
        const conversationContext = url.searchParams
          .getAll("context")
          .map((v) => String(v || "").trim())
          .filter(Boolean)
          .slice(-5);

        if (options.recallService) {
          const result = await options.recallService.search({
            project_id: projectId,
            subject_id: subjectId,
            query: q,
            limit,
            min_score: Number.isFinite(minScore) ? minScore : 30,
            conversation_context: conversationContext,
          });
          const data = result.memories.map((m) => ({
            id: m.id,
            text: m.text,
            kind: m.kind,
            importance: m.importance,
            is_temporal: m.is_temporal,
            created_at: m.created_at,
            score: Number(m.score) || 0,
            effective_score: Number(m.effective_score) || 0,
          }));
          sendJson(res, 200, {
            data,
            query: q,
            count: data.length,
            engine: options.recallService.name,
            mode: result.mode,
            used_queries: result.used_queries,
            predicates: result.predicates,
          });
          debugLog("request.end", {
            method,
            path,
            status: 200,
            engine: options.recallService.name,
            mode: result.mode,
            count: data.length,
            duration_ms: Date.now() - startedAt,
          });
          return;
        }

        let embedding: number[] | null = null;
        if (options.embed) {
          try {
            embedding = await options.embed(q);
          } catch {
            embedding = null;
          }
        }
        const data = await options.store.searchMemories({
          project_id: projectId,
          subject_id: subjectId,
          q,
          query_embedding: embedding,
          limit,
          min_score: Number.isFinite(minScore) ? minScore : 30,
        });
        const mapped = data.map((m) => mapMemorySearchResult(m as unknown as Record<string, any>));
        sendJson(res, 200, { data: mapped, query: q, count: mapped.length, engine: "fallback" });
        debugLog("request.end", {
          method,
          path,
          status: 200,
          engine: "fallback",
          count: mapped.length,
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      if (method === "GET" && path === "/api/v1/memories/superseded") {
        const subjectId = String(url.searchParams.get("subject_id") || "").trim();
        if (!subjectId) {
          sendJson(res, 400, { error: "subject_id_required" });
          return;
        }
        const limit = parseIntInRange(url.searchParams.get("limit"), 50, 1, 200);
        const offset = parseIntInRange(url.searchParams.get("offset"), 0, 0, 1_000_000);
        const data = await options.store.listSupersededMemories({
          project_id: projectId,
          subject_id: subjectId,
          limit,
          offset,
        });
        const sanitized = data.map((m) => sanitizeMemoryForApi(m as unknown as Record<string, any>));
        sendJson(res, 200, { data: sanitized, count: sanitized.length });
        return;
      }

      if (method === "GET" && path === "/api/v1/memories/recalls") {
        const chatId = String(url.searchParams.get("chat_id") || "").trim();
        const memoryId = String(url.searchParams.get("memory_id") || "").trim();
        const stats = parseBool(url.searchParams.get("stats"), false);
        const limit = parseIntInRange(url.searchParams.get("limit"), 100, 1, 1000);

        if (!chatId && !memoryId) {
          sendJson(res, 400, {
            error: "missing_parameter",
            message: "Provide either chat_id or memory_id",
          });
          return;
        }
        if (chatId) {
          const data = await options.store.getRecallEventsByChat({
            project_id: projectId,
            chat_id: chatId,
          });
          sendJson(res, 200, { data, count: data.length, chat_id: chatId });
          return;
        }
        if (stats) {
          const data = await options.store.getMemoryRecallStats({
            project_id: projectId,
            memory_id: memoryId,
          });
          sendJson(res, 200, { memory_id: memoryId, stats: data });
          return;
        }
        const data = await options.store.getRecallEventsByMemory({
          project_id: projectId,
          memory_id: memoryId,
          limit,
        });
        sendJson(res, 200, { data, count: data.length, memory_id: memoryId });
        return;
      }

      const memoriesClaimsMatch = path.match(/^\/api\/v1\/memories\/([^/]+)\/claims$/);
      if (method === "GET" && memoriesClaimsMatch) {
        const memoryId = decodePathPart(memoriesClaimsMatch[1]);
        const memory = await options.store.getMemory({ project_id: projectId, id: memoryId });
        if (!memory) {
          sendJson(res, 404, { error: "memory_not_found" });
          return;
        }
        if (memory.is_deleted) {
          sendJson(res, 404, { error: "memory_deleted" });
          return;
        }
        const claims = await options.store.getMemoryClaims({
          project_id: projectId,
          memory_id: memoryId,
        });
        const data = claims.map((row) => {
          let value: unknown = row.value_string;
          if (row.object_type === "number") value = row.value_number;
          if (row.object_type === "date") value = row.value_date;
          if (row.object_type === "json") value = row.value_json;
          return {
            id: row.assertion_id,
            predicate: row.predicate,
            type: row.object_type,
            value,
            confidence: row.confidence,
            status: row.status,
            first_seen_at: row.first_seen_at,
            last_seen_at: row.last_seen_at,
          };
        });
        sendJson(res, 200, { data, count: data.length });
        return;
      }

      const memoriesRestoreMatch = path.match(/^\/api\/v1\/memories\/([^/]+)\/restore$/);
      if (method === "POST" && memoriesRestoreMatch) {
        const memoryId = decodePathPart(memoriesRestoreMatch[1]);
        const existing = await options.store.getMemory({ project_id: projectId, id: memoryId });
        if (!existing) {
          sendJson(res, 404, { error: "memory_not_found" });
          return;
        }
        if (existing.is_deleted) {
          sendJson(res, 400, {
            error: "memory_deleted",
            message: "Cannot restore a deleted memory",
          });
          return;
        }
        if (existing.status === "active") {
          sendJson(res, 200, {
            ok: true,
            restored: false,
            message: "Memory is already active",
          });
          return;
        }

        const restored = await options.store.restoreMemory({
          project_id: projectId,
          id: memoryId,
        });
        if (!restored) {
          sendJson(res, 404, { error: "memory_not_found" });
          return;
        }
        bus.emit(projectId, restored.subject_id, "memory.updated", {
          id: restored.id,
          status: restored.status,
        });
        sendJson(res, 200, {
          ok: true,
          restored: true,
          id: restored.id,
          subject_id: restored.subject_id,
          text: restored.text,
        });
        return;
      }

      const memoryIdMatch = path.match(/^\/api\/v1\/memories\/([^/]+)$/);
      if (memoryIdMatch) {
        const memoryId = decodePathPart(memoryIdMatch[1]);
        if (method === "GET") {
          const memory = await options.store.getMemory({ project_id: projectId, id: memoryId });
          if (!memory) {
            sendJson(res, 404, { error: "memory_not_found" });
            return;
          }
          if (memory.is_deleted) {
            sendJson(res, 404, { error: "memory_deleted" });
            return;
          }
          sendJson(res, 200, { data: sanitizeMemoryForApi(memory as unknown as Record<string, any>) });
          return;
        }
        if (method === "PATCH") {
          const body = await readJsonBody(req);
          if (!body) {
            sendJson(res, 400, { error: "invalid_json_body" });
            return;
          }
          const existing = await options.store.getMemory({ project_id: projectId, id: memoryId });
          if (!existing) {
            sendJson(res, 404, { error: "memory_not_found" });
            return;
          }
          if (existing.is_deleted) {
            sendJson(res, 404, { error: "memory_deleted" });
            return;
          }
          let embedding: number[] | null | undefined = undefined;
          if (typeof body.text === "string" && body.text.trim() && options.embed) {
            try {
              embedding = await options.embed(body.text.trim());
            } catch {
              embedding = undefined;
            }
          }
          const updated = await options.store.updateMemory({
            project_id: projectId,
            id: memoryId,
            patch: {
              text: body.text,
              kind: body.kind,
              visibility: body.visibility,
              importance: body.importance,
              confidence: body.confidence,
              is_temporal: body.is_temporal,
              tags: Array.isArray(body.tags) ? body.tags : undefined,
              metadata: body.metadata,
              embedding,
            },
          });
          if (!updated) {
            sendJson(res, 404, { error: "memory_not_found" });
            return;
          }
          bus.emit(projectId, updated.subject_id, "memory.updated", {
            id: updated.id,
            subject_id: updated.subject_id,
          });
          sendJson(res, 200, { id: updated.id, updated: true });
          return;
        }
        if (method === "DELETE") {
          const existing = await options.store.getMemory({ project_id: projectId, id: memoryId });
          const result = await options.store.deleteMemory({ project_id: projectId, id: memoryId });
          if (result.deleted && existing) {
            bus.emit(projectId, existing.subject_id, "memory.deleted", { id: memoryId });
          }
          sendJson(res, 200, { ok: true, deleted: result.deleted });
          return;
        }
      }

      if (method === "POST" && path === "/api/v1/memories") {
        const body = await readJsonBody(req);
        if (!body) {
          sendJson(res, 400, { error: "invalid_json_body" });
          return;
        }
        const subjectId = String(body.subject_id || "").trim();
        const text = String(body.text || "").trim();
        if (!subjectId) {
          sendJson(res, 400, { error: "subject_id_required" });
          return;
        }
        if (!text) {
          sendJson(res, 400, { error: "text_required" });
          return;
        }
        if (text.length > 10000) {
          sendJson(res, 400, { error: "text_too_long", max: 10000 });
          return;
        }

        const extractClaims = body.extract_claims !== false;
        const noSupersede = body.no_supersede === true;

        let embedding: number[] | null = null;
        if (options.embed) {
          try {
            embedding = await options.embed(text);
          } catch {
            embedding = null;
          }
        }

        const embeddingVector = Array.isArray(embedding) && embedding.length > 0 ? embedding : null;

        if (embeddingVector && options.store.findDuplicateMemory) {
          const duplicate = await options.store.findDuplicateMemory({
            project_id: projectId,
            subject_id: subjectId,
            embedding: embeddingVector,
            threshold: 85,
          });
          if (duplicate) {
            sendJson(res, 200, {
              id: null,
              subject_id: subjectId,
              text,
              kind: body.kind || "fact",
              created: false,
              skipped: true,
              reason: "duplicate",
            });
            debugLog("request.end", {
              method,
              path,
              status: 200,
              subject_id: subjectId,
              skipped: "duplicate",
              duration_ms: Date.now() - startedAt,
            });
            return;
          }
        }

        let conflictingIds: string[] = [];
        if (embeddingVector && !noSupersede && options.store.findConflictingMemories) {
          const conflicts = await options.store.findConflictingMemories({
            project_id: projectId,
            subject_id: subjectId,
            embedding: embeddingVector,
            min_similarity: 60,
            max_similarity: 85,
            limit: 50,
          });
          conflictingIds = conflicts.map((c) => String(c.id || "").trim()).filter(Boolean);
        }

        const id = String(body.id || `mem_${randomUUID()}`);
        const memory = await options.store.createMemory({
          id,
          project_id: projectId,
          subject_id: subjectId,
          text,
          kind: body.kind,
          visibility: body.visibility,
          importance: body.importance,
          confidence: body.confidence,
          is_temporal: body.is_temporal,
          tags: Array.isArray(body.tags) ? body.tags : [],
          metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
          source_type: body.source_type || "explicit",
          embedding,
        });

        let supersededCount = 0;
        if (conflictingIds.length > 0 && options.store.supersedeMemories) {
          supersededCount = await options.store.supersedeMemories({
            project_id: projectId,
            subject_id: subjectId,
            memory_ids: conflictingIds,
            superseded_by: memory.id,
          });
        }

        bus.emit(projectId, subjectId, "memory.created", {
          id: memory.id,
          subject_id: memory.subject_id,
          text: memory.text,
          kind: memory.kind,
          visibility: memory.visibility,
          importance: memory.importance,
          tags: memory.tags,
          created_at: memory.created_at,
        });

        if (supersededCount > 0) {
          for (const conflictId of conflictingIds) {
            bus.emit(projectId, subjectId, "memory.superseded", {
              id: conflictId,
              superseded_by: memory.id,
            });
          }
        }

        if (extractClaims && !noSupersede) {
          void (async () => {
            try {
              const extracted = await extractionService.extract({
                subject_id: subjectId,
                text,
                force: true,
              });
              const seen = new Set<string>();
              const claims = extracted.memories
                .flatMap((m) => (Array.isArray(m.claims) ? m.claims : []))
                .map((claim) => ({
                  predicate: String(claim?.predicate || "").trim(),
                  object_value: String(claim?.object_value || "").trim(),
                  claim_type: claim?.claim_type ? String(claim.claim_type) : undefined,
                  confidence: Number(claim?.confidence),
                }))
                .filter((claim) => claim.predicate && claim.object_value)
                .filter((claim) => {
                  const key = `${claim.predicate.toLowerCase()}::${claim.object_value.toLowerCase()}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                })
                .slice(0, 20);

              for (const claim of claims) {
                let claimEmbedding: number[] | null = null;
                if (options.embed) {
                  try {
                    claimEmbedding = await options.embed(`${claim.predicate}: ${claim.object_value}`);
                  } catch {
                    claimEmbedding = null;
                  }
                }
                await options.store.createClaim({
                  claim_id: `clm_${randomUUID()}`,
                  project_id: projectId,
                  subject_id: subjectId,
                  predicate: claim.predicate,
                  object_value: claim.object_value,
                  claim_type: claim.claim_type,
                  confidence: Number.isFinite(claim.confidence) ? claim.confidence : undefined,
                  source_memory_id: memory.id,
                  embedding: claimEmbedding,
                });
              }
            } catch (extractErr) {
              debugLog("memories.create.extract_claims_failed", {
                subject_id: subjectId,
                memory_id: memory.id,
                message: toErrorMessage(extractErr),
              });
            }
          })();
        }

        sendJson(res, 201, {
          id: memory.id,
          subject_id: memory.subject_id,
          text: memory.text,
          kind: memory.kind,
          created: true,
          superseded_count: supersededCount,
          superseded_ids: conflictingIds,
        });
        debugLog("request.end", {
          method,
          path,
          status: 201,
          memory_id: memory.id,
          subject_id: memory.subject_id,
          superseded_count: supersededCount,
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      // ------------------------------------------------------------------
      // Claims
      // ------------------------------------------------------------------
      if (method === "POST" && path === "/api/v1/claims") {
        const body = await readJsonBody(req);
        if (!body) {
          sendJson(res, 400, { error: "invalid_json_body" });
          return;
        }
        const subjectId = String(body.subject_id || "").trim();
        const predicate = String(body.predicate || "").trim();
        const objectValue = String(body.object_value || "").trim();
        if (!subjectId) {
          sendJson(res, 400, { error: "subject_id_required" });
          return;
        }
        if (!predicate) {
          sendJson(res, 400, { error: "predicate_required" });
          return;
        }
        if (!objectValue) {
          sendJson(res, 400, { error: "object_value_required" });
          return;
        }
        let embedding: number[] | null = null;
        if (options.embed) {
          try {
            embedding = await options.embed(`${predicate}: ${objectValue}`);
          } catch {
            embedding = null;
          }
        }

        const claimId = String(body.claim_id || `clm_${randomUUID()}`);
        const claim = await options.store.createClaim({
          claim_id: claimId,
          project_id: projectId,
          subject_id: subjectId,
          predicate,
          object_value: objectValue,
          claim_type: body.claim_type,
          slot: body.slot,
          confidence: body.confidence,
          importance: body.importance,
          tags: Array.isArray(body.tags) ? body.tags : [],
          source_memory_id: body.source_memory_id || null,
          source_observation_id: body.source_observation_id || null,
          subject_entity: body.subject_entity || "self",
          valid_from: body.valid_from || null,
          valid_until: body.valid_until || null,
          embedding,
        });

        sendJson(res, 201, {
          claim_id: claim.claim_id,
          subject_id: claim.subject_id,
          predicate: claim.predicate,
          object_value: claim.object_value,
          slot: claim.slot,
          claim_type: claim.claim_type,
          confidence: claim.confidence,
          observation_id: claim.source_observation_id,
          linking_triggered: true,
        });
        return;
      }

      const claimRetractMatch = path.match(/^\/api\/v1\/claims\/([^/]+)\/retract$/);
      if (method === "POST" && claimRetractMatch) {
        const claimId = decodePathPart(claimRetractMatch[1]);
        const body = await readJsonBody(req);
        const reason = String(body?.reason || "manual_retraction");
        const result = await options.store.retractClaim({
          project_id: projectId,
          claim_id: claimId,
          reason,
        });
        if (!result.success) {
          sendJson(res, 404, { error: "claim_not_found" });
          return;
        }
        sendJson(res, 200, {
          success: true,
          claim_id: result.claim_id,
          slot: result.slot,
          previous_claim_id: result.previous_claim_id,
          restored_previous: result.restored_previous,
          reason,
        });
        return;
      }

      const claimsTruthMatch = path.match(/^\/api\/v1\/claims\/subject\/([^/]+)\/truth$/);
      if (method === "GET" && claimsTruthMatch) {
        const subjectId = decodePathPart(claimsTruthMatch[1]);
        if (!subjectId) {
          sendJson(res, 400, { error: "subject_id_required" });
          return;
        }
        const includeSource = parseBool(url.searchParams.get("include_source"), true);
        const slots = await options.store.getCurrentTruth({
          project_id: projectId,
          subject_id: subjectId,
        });
        const data = slots.map((s) => {
          if (!includeSource) {
            const { source_memory_id, source_observation_id, ...rest } = s;
            return rest;
          }
          return {
            ...s,
            source: {
              memory_id: s.source_memory_id || null,
              observation_id: s.source_observation_id || null,
            },
          };
        });
        sendJson(res, 200, {
          subject_id: subjectId,
          project_id: projectId,
          slot_count: slots.length,
          slots: data,
        });
        return;
      }

      const claimsSlotMatch = path.match(/^\/api\/v1\/claims\/subject\/([^/]+)\/slot\/([^/]+)$/);
      if (method === "GET" && claimsSlotMatch) {
        const subjectId = decodePathPart(claimsSlotMatch[1]);
        const slot = decodePathPart(claimsSlotMatch[2]);
        if (!subjectId) {
          sendJson(res, 400, { error: "subject_id_required" });
          return;
        }
        if (!slot) {
          sendJson(res, 400, { error: "slot_required" });
          return;
        }
        const row = await options.store.getCurrentSlot({
          project_id: projectId,
          subject_id: subjectId,
          slot,
        });
        if (!row) {
          sendJson(res, 404, { error: "slot_not_found", subject_id: subjectId, slot });
          return;
        }
        sendJson(res, 200, {
          subject_id: subjectId,
          project_id: projectId,
          slot: row.slot,
          active_claim_id: row.active_claim_id,
          predicate: row.predicate,
          object_value: row.object_value,
          claim_type: row.claim_type,
          confidence: row.confidence,
          updated_at: row.updated_at,
          tags: row.tags || [],
          source: {
            memory_id: row.source_memory_id || null,
            observation_id: row.source_observation_id || null,
          },
        });
        return;
      }

      const claimsSlotsMatch = path.match(/^\/api\/v1\/claims\/subject\/([^/]+)\/slots$/);
      if (method === "GET" && claimsSlotsMatch) {
        const subjectId = decodePathPart(claimsSlotsMatch[1]);
        const limit = parseIntInRange(url.searchParams.get("limit"), 100, 1, 500);
        const rows = await options.store.getSlots({
          project_id: projectId,
          subject_id: subjectId,
          limit,
        });
        const active = rows.filter((r) => r.status === "active");
        const superseded = rows.filter((r) => r.status === "superseded");
        const other = rows.filter((r) => r.status !== "active" && r.status !== "superseded");
        sendJson(res, 200, {
          subject_id: subjectId,
          total: rows.length,
          active_count: active.length,
          slots: {
            active,
            superseded,
            other,
          },
        });
        return;
      }

      const claimsGraphMatch = path.match(/^\/api\/v1\/claims\/subject\/([^/]+)\/graph$/);
      if (method === "GET" && claimsGraphMatch) {
        const subjectId = decodePathPart(claimsGraphMatch[1]);
        const limit = parseIntInRange(url.searchParams.get("limit"), 50, 1, 200);
        const graph = await options.store.getClaimGraph({
          project_id: projectId,
          subject_id: subjectId,
          limit,
        });
        const edgesByType: Record<string, number> = {};
        for (const edge of graph.edges) {
          edgesByType[edge.edge_type] = (edgesByType[edge.edge_type] || 0) + 1;
        }
        sendJson(res, 200, {
          subject_id: subjectId,
          claims_count: graph.claims.length,
          edges_count: graph.edges.length,
          edges_by_type: edgesByType,
          claims: graph.claims,
          edges: graph.edges,
        });
        return;
      }

      const claimsHistoryMatch = path.match(/^\/api\/v1\/claims\/subject\/([^/]+)\/history$/);
      if (method === "GET" && claimsHistoryMatch) {
        const subjectId = decodePathPart(claimsHistoryMatch[1]);
        const slot = String(url.searchParams.get("slot") || "").trim() || null;
        const limit = parseIntInRange(url.searchParams.get("limit"), 100, 1, 500);
        const history = await options.store.getClaimHistory({
          project_id: projectId,
          subject_id: subjectId,
          slot,
          limit,
        });
        sendJson(res, 200, {
          subject_id: subjectId,
          project_id: projectId,
          slot_filter: slot,
          by_slot: history.by_slot,
          edges: history.edges,
          total_claims: history.claims.length,
        });
        return;
      }

      const claimIdMatch = path.match(/^\/api\/v1\/claims\/([^/]+)$/);
      if (method === "GET" && claimIdMatch) {
        const claimId = decodePathPart(claimIdMatch[1]);
        const claim = await options.store.getClaim({ project_id: projectId, claim_id: claimId });
        if (!claim) {
          sendJson(res, 404, { error: "claim_not_found" });
          return;
        }
        const assertions = await options.store.getAssertionsForClaim({
          project_id: projectId,
          claim_id: claimId,
        });
        const edges = await options.store.getEdgesForClaim({
          project_id: projectId,
          claim_id: claimId,
        });
        const supersessionChain = edges.filter((e) => e.edge_type === "supersedes");
        const { embedding: _embedding, ...claimWithoutEmbedding } = claim as Record<string, any>;
        sendJson(res, 200, {
          claim: claimWithoutEmbedding,
          assertions,
          edges,
          supersession_chain: supersessionChain,
        });
        return;
      }

      sendJson(res, 404, { error: "not_found", path, method });
        debugLog("request.end", { method, path, status: 404, duration_ms: Date.now() - startedAt });
    } catch (err: any) {
      const errMsg = toErrorMessage(err);
      console.error("[core] request error", {
        method,
        path,
        projectId,
        message: errMsg,
      });
      if (debugEnabled) {
        console.error("[core][debug] stack", err?.stack || "(no stack)");
      }
      sendJson(res, 500, {
        error: "server_error",
        message: errMsg,
      });
      debugLog("request.end", {
        method,
        path,
        status: 500,
        error: errMsg,
        duration_ms: Date.now() - startedAt,
      });
    }
  });
}
