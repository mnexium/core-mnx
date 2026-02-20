import type { Pool } from "pg";
import { randomUUID } from "crypto";
import type {
  Claim,
  ClaimAssertion,
  ClaimEdge,
  Memory,
  MemoryRecallEvent,
  MemoryRecallStats,
  ResolvedTruthSlot,
} from "../../contracts/types";
import type {
  CoreStore,
  CreateClaimInput,
  CreateMemoryInput,
  UpdateMemoryInput,
} from "../../contracts/storage";

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

function clampFloat(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function toVectorLiteral(embedding: number[] | null | undefined): string | null {
  if (!Array.isArray(embedding) || embedding.length === 0) return null;
  const safe = embedding
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .map((v) => (Object.is(v, -0) ? 0 : v));
  if (safe.length === 0) return null;
  return `[${safe.join(",")}]`;
}

const SEARCH_STOP_WORDS = new Set<string>([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "personal",
  "preference",
  "preferences",
  "the",
  "to",
  "user",
  "users",
  "what",
  "where",
  "who",
  "why",
  "you",
  "your",
]);

function buildSearchTokens(query: string): string[] {
  const raw = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);
  const filtered = raw.filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of filtered) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.slice(0, 10);
}

function inferSlot(predicate: string): string {
  return String(predicate || "").trim();
}

function inferClaimType(predicate: string): string {
  const p = String(predicate || "").trim();
  if (!p) return "fact";
  if (p.startsWith("favorite_") || p.startsWith("likes_") || p.startsWith("dislikes_")) return "preference";
  if (p.includes("goal") || p.startsWith("wants_")) return "goal";
  if (p.startsWith("did_") || p.startsWith("event_")) return "event";
  return "fact";
}

export class PostgresCoreStore implements CoreStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async listMemories(args: {
    project_id: string;
    subject_id: string;
    limit: number;
    offset: number;
    include_deleted?: boolean;
    include_superseded?: boolean;
  }): Promise<Memory[]> {
    const limit = clampInt(args.limit, 1, 200, 50);
    const offset = clampInt(args.offset, 0, 1_000_000, 0);
    const includeDeleted = args.include_deleted === true;
    const includeSuperseded = args.include_superseded === true;

    const result = await this.pool.query(
      `
        SELECT *
        FROM memories
        WHERE project_id = $1
          AND subject_id = $2
          AND ($3::boolean = TRUE OR is_deleted = FALSE)
          AND ($4::boolean = TRUE OR status = 'active')
        ORDER BY created_at DESC
        LIMIT $5 OFFSET $6
      `,
      [args.project_id, args.subject_id, includeDeleted, includeSuperseded, limit, offset],
    );

    return result.rows;
  }

  async searchMemories(args: {
    project_id: string;
    subject_id: string;
    q: string;
    query_embedding: number[] | null;
    limit: number;
    min_score: number;
  }): Promise<Array<Memory & { score: number; effective_score: number }>> {
    const limit = clampInt(args.limit, 1, 200, 25);
    const minScore = clampFloat(args.min_score, 0, 100, 30);
    const q = String(args.q || "").trim();
    const searchTokens = buildSearchTokens(q);
    const vector = toVectorLiteral(args.query_embedding);

    if (vector) {
      const result = await this.pool.query(
        `
          SELECT
            m.*,
            (
              CASE
                WHEN m.embedding IS NULL THEN 0
                ELSE ((1 - (m.embedding <=> $3::vector)) * 100)
              END
            ) AS score,
            ((0.60 * (
                CASE
                  WHEN m.embedding IS NULL THEN 0
                  ELSE ((1 - (m.embedding <=> $3::vector)) * 100)
                END
              ))
              + (0.25 * m.importance)
              + (0.15 * m.confidence * 100)
              + (
                CASE
                  WHEN $4::text <> '' AND m.text ILIKE ('%' || $4 || '%') THEN 20
                  WHEN EXISTS (
                    SELECT 1
                    FROM unnest($6::text[]) AS tok(token)
                    WHERE m.text ILIKE ('%' || tok.token || '%')
                  ) THEN 16
                  ELSE 0
                END
              )
            ) AS effective_score
          FROM memories m
          WHERE m.project_id = $1
            AND m.subject_id = $2
            AND m.is_deleted = FALSE
            AND m.status = 'active'
            AND (
              $4::text = ''
              OR m.text ILIKE ('%' || $4 || '%')
              OR EXISTS (
                SELECT 1
                FROM unnest($6::text[]) AS tok(token)
                WHERE m.text ILIKE ('%' || tok.token || '%')
              )
              OR (
                m.embedding IS NOT NULL
                AND ((1 - (m.embedding <=> $3::vector)) * 100) >= $5
              )
            )
          ORDER BY effective_score DESC, score DESC
          LIMIT $7
        `,
        [args.project_id, args.subject_id, vector, q, minScore, searchTokens, limit],
      );
      return result.rows;
    }

    const result = await this.pool.query(
      `
        SELECT
          m.*,
          0::double precision AS score,
          (0.25 * m.importance + 0.15 * m.confidence * 100)::double precision AS effective_score
        FROM memories m
        WHERE m.project_id = $1
          AND m.subject_id = $2
          AND m.is_deleted = FALSE
          AND m.status = 'active'
          AND (
            $3::text = ''
            OR m.text ILIKE ('%' || $3 || '%')
            OR EXISTS (
              SELECT 1
              FROM unnest($5::text[]) AS tok(token)
              WHERE m.text ILIKE ('%' || tok.token || '%')
            )
          )
        ORDER BY m.importance DESC, m.created_at DESC
        LIMIT $4
      `,
      [args.project_id, args.subject_id, q, limit, searchTokens],
    );
    return result.rows;
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const result = await this.pool.query(
      `
        INSERT INTO memories (
          id, project_id, subject_id, text, kind, visibility, importance,
          confidence, is_temporal, tags, metadata, embedding, source_type,
          status, superseded_by, is_deleted, last_reinforced_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11::jsonb, $12::vector, $13,
          'active', NULL, FALSE, NOW()
        )
        RETURNING *
      `,
      [
        input.id,
        input.project_id,
        input.subject_id,
        String(input.text || "").trim(),
        input.kind || "fact",
        input.visibility || "private",
        clampInt(input.importance, 0, 100, 50),
        clampFloat(input.confidence, 0, 1, 0.95),
        input.is_temporal === true,
        Array.isArray(input.tags) ? input.tags.map(String) : [],
        JSON.stringify(input.metadata || {}),
        toVectorLiteral(input.embedding),
        input.source_type || "explicit",
      ],
    );
    return result.rows[0];
  }

  async getMemory(args: { project_id: string; id: string }): Promise<Memory | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM memories
        WHERE project_id = $1
          AND id = $2
        LIMIT 1
      `,
      [args.project_id, args.id],
    );
    return result.rows[0] || null;
  }

  async getMemoryClaims(args: { project_id: string; memory_id: string }): Promise<ClaimAssertion[]> {
    const result = await this.pool.query(
      `
        SELECT
          ca.assertion_id,
          ca.project_id,
          ca.subject_id,
          ca.claim_id,
          ca.memory_id,
          ca.predicate,
          ca.object_type,
          ca.value_string,
          ca.value_number,
          ca.value_date,
          ca.value_json,
          ca.confidence,
          ca.status,
          ca.first_seen_at,
          ca.last_seen_at
        FROM claim_assertions ca
        WHERE ca.project_id = $1
          AND ca.memory_id = $2
        ORDER BY ca.last_seen_at DESC
      `,
      [args.project_id, args.memory_id],
    );
    return result.rows;
  }

  async updateMemory(args: { project_id: string; id: string; patch: UpdateMemoryInput }): Promise<Memory | null> {
    const existing = await this.getMemory({ project_id: args.project_id, id: args.id });
    if (!existing) return null;

    const patch = args.patch || {};
    const merged = {
      text: patch.text !== undefined ? String(patch.text).trim() : existing.text,
      kind: patch.kind !== undefined ? patch.kind : existing.kind,
      visibility: patch.visibility !== undefined ? patch.visibility : existing.visibility,
      importance: patch.importance !== undefined ? clampInt(patch.importance, 0, 100, existing.importance) : existing.importance,
      confidence: patch.confidence !== undefined ? clampFloat(patch.confidence, 0, 1, existing.confidence) : existing.confidence,
      is_temporal: patch.is_temporal !== undefined ? patch.is_temporal : existing.is_temporal,
      tags: patch.tags !== undefined ? patch.tags.map(String) : existing.tags,
      metadata: patch.metadata !== undefined ? patch.metadata : existing.metadata,
      embedding: patch.embedding !== undefined ? patch.embedding : null,
    };

    const result = await this.pool.query(
      `
        UPDATE memories
        SET
          text = $3,
          kind = $4,
          visibility = $5,
          importance = $6,
          confidence = $7,
          is_temporal = $8,
          tags = $9,
          metadata = $10::jsonb,
          embedding = COALESCE($11::vector, embedding)
        WHERE project_id = $1
          AND id = $2
        RETURNING *
      `,
      [
        args.project_id,
        args.id,
        merged.text,
        merged.kind,
        merged.visibility,
        merged.importance,
        merged.confidence,
        merged.is_temporal,
        merged.tags,
        JSON.stringify(merged.metadata || {}),
        toVectorLiteral(merged.embedding),
      ],
    );

    return result.rows[0] || null;
  }

  async deleteMemory(args: { project_id: string; id: string }): Promise<{ ok: true; deleted: boolean }> {
    const result = await this.pool.query(
      `
        UPDATE memories
        SET is_deleted = TRUE
        WHERE project_id = $1
          AND id = $2
          AND is_deleted = FALSE
      `,
      [args.project_id, args.id],
    );
    return { ok: true, deleted: result.rowCount > 0 };
  }

  async listSupersededMemories(args: {
    project_id: string;
    subject_id: string;
    limit: number;
    offset: number;
  }): Promise<Memory[]> {
    const limit = clampInt(args.limit, 1, 200, 50);
    const offset = clampInt(args.offset, 0, 1_000_000, 0);
    const result = await this.pool.query(
      `
        SELECT *
        FROM memories
        WHERE project_id = $1
          AND subject_id = $2
          AND is_deleted = FALSE
          AND status = 'superseded'
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      `,
      [args.project_id, args.subject_id, limit, offset],
    );
    return result.rows;
  }

  async restoreMemory(args: { project_id: string; id: string }): Promise<Memory | null> {
    const result = await this.pool.query(
      `
        UPDATE memories
        SET status = 'active', superseded_by = NULL
        WHERE project_id = $1
          AND id = $2
          AND is_deleted = FALSE
        RETURNING *
      `,
      [args.project_id, args.id],
    );
    return result.rows[0] || null;
  }

  async findDuplicateMemory(args: {
    project_id: string;
    subject_id: string;
    embedding: number[];
    threshold: number;
  }): Promise<{ id: string; similarity: number } | null> {
    const vector = toVectorLiteral(args.embedding);
    if (!vector) return null;
    const threshold = clampFloat(args.threshold, 0, 100, 85);
    const result = await this.pool.query(
      `
        SELECT
          m.id,
          ((1 - (m.embedding <=> $3::vector)) * 100) AS similarity
        FROM memories m
        WHERE m.project_id = $1
          AND m.subject_id = $2
          AND m.is_deleted = FALSE
          AND m.status = 'active'
          AND m.embedding IS NOT NULL
          AND ((1 - (m.embedding <=> $3::vector)) * 100) >= $4
        ORDER BY similarity DESC
        LIMIT 1
      `,
      [args.project_id, args.subject_id, vector, threshold],
    );
    return result.rows[0] || null;
  }

  async findConflictingMemories(args: {
    project_id: string;
    subject_id: string;
    embedding: number[];
    min_similarity: number;
    max_similarity: number;
    limit: number;
  }): Promise<Array<{ id: string; similarity: number }>> {
    const vector = toVectorLiteral(args.embedding);
    if (!vector) return [];
    const minSimilarity = clampFloat(args.min_similarity, 0, 100, 60);
    const maxSimilarity = clampFloat(args.max_similarity, minSimilarity, 100, 85);
    const limit = clampInt(args.limit, 1, 200, 25);
    const result = await this.pool.query(
      `
        SELECT
          m.id,
          ((1 - (m.embedding <=> $3::vector)) * 100) AS similarity
        FROM memories m
        WHERE m.project_id = $1
          AND m.subject_id = $2
          AND m.is_deleted = FALSE
          AND m.status = 'active'
          AND m.embedding IS NOT NULL
          AND ((1 - (m.embedding <=> $3::vector)) * 100) >= $4
          AND ((1 - (m.embedding <=> $3::vector)) * 100) < $5
        ORDER BY similarity DESC
        LIMIT $6
      `,
      [args.project_id, args.subject_id, vector, minSimilarity, maxSimilarity, limit],
    );
    return result.rows;
  }

  async supersedeMemories(args: {
    project_id: string;
    subject_id: string;
    memory_ids: string[];
    superseded_by: string;
  }): Promise<number> {
    const ids = Array.isArray(args.memory_ids) ? args.memory_ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `
        UPDATE memories
        SET status = 'superseded', superseded_by = $4
        WHERE project_id = $1
          AND subject_id = $2
          AND id = ANY($3::text[])
          AND is_deleted = FALSE
          AND status = 'active'
      `,
      [args.project_id, args.subject_id, ids, args.superseded_by],
    );
    return Number(result.rowCount || 0);
  }

  async getRecallEventsByChat(args: { project_id: string; chat_id: string }): Promise<MemoryRecallEvent[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM memory_recall_events
        WHERE project_id = $1
          AND chat_id = $2
        ORDER BY recalled_at ASC, message_index ASC
      `,
      [args.project_id, args.chat_id],
    );
    return result.rows;
  }

  async getRecallEventsByMemory(args: {
    project_id: string;
    memory_id: string;
    limit: number;
  }): Promise<MemoryRecallEvent[]> {
    const limit = clampInt(args.limit, 1, 1000, 100);
    const result = await this.pool.query(
      `
        SELECT *
        FROM memory_recall_events
        WHERE project_id = $1
          AND memory_id = $2
        ORDER BY recalled_at DESC
        LIMIT $3
      `,
      [args.project_id, args.memory_id, limit],
    );
    return result.rows;
  }

  async getMemoryRecallStats(args: {
    project_id: string;
    memory_id: string;
  }): Promise<MemoryRecallStats> {
    const result = await this.pool.query(
      `
        SELECT
          COUNT(*)::int AS total_recalls,
          COUNT(DISTINCT chat_id)::int AS unique_chats,
          COUNT(DISTINCT subject_id)::int AS unique_subjects,
          COALESCE(AVG(similarity_score), 0)::double precision AS avg_score,
          MIN(recalled_at) AS first_recalled_at,
          MAX(recalled_at) AS last_recalled_at
        FROM memory_recall_events
        WHERE project_id = $1
          AND memory_id = $2
      `,
      [args.project_id, args.memory_id],
    );
    return (
      result.rows[0] || {
        total_recalls: 0,
        unique_chats: 0,
        unique_subjects: 0,
        avg_score: 0,
        first_recalled_at: null,
        last_recalled_at: null,
      }
    );
  }

  async createClaim(input: CreateClaimInput): Promise<Claim> {
    const slot = input.slot || inferSlot(input.predicate);
    const claimType = input.claim_type || inferClaimType(input.predicate);
    const confidence = clampFloat(input.confidence, 0, 1, 0.8);
    const importance = clampFloat(input.importance, 0, 1, 0.5);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const claimResult = await client.query(
        `
          INSERT INTO claims (
            claim_id, project_id, subject_id, predicate, object_value, slot, claim_type,
            confidence, importance, tags, source_memory_id, source_observation_id,
            subject_entity, status, embedding, valid_from, valid_until
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12,
            $13, 'active', $14::vector, $15::timestamptz, $16::timestamptz
          )
          RETURNING *
        `,
        [
          input.claim_id,
          input.project_id,
          input.subject_id,
          input.predicate,
          input.object_value,
          slot,
          claimType,
          confidence,
          importance,
          Array.isArray(input.tags) ? input.tags.map(String) : [],
          input.source_memory_id || null,
          input.source_observation_id || null,
          input.subject_entity || "self",
          toVectorLiteral(input.embedding),
          input.valid_from || null,
          input.valid_until || null,
        ],
      );

      const assertionId = `ast_${randomUUID()}`;
      await client.query(
        `
          INSERT INTO claim_assertions (
            assertion_id, project_id, subject_id, claim_id, memory_id,
            predicate, object_type, value_string, confidence, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'string', $7, $8, 'active')
        `,
        [
          assertionId,
          input.project_id,
          input.subject_id,
          input.claim_id,
          input.source_memory_id || null,
          input.predicate,
          input.object_value,
          confidence,
        ],
      );

      await client.query(
        `
          INSERT INTO slot_state (
            project_id, subject_id, slot, active_claim_id, status, replaced_by_claim_id
          )
          VALUES ($1, $2, $3, $4, 'active', NULL)
          ON CONFLICT (project_id, subject_id, slot)
          DO UPDATE SET
            active_claim_id = EXCLUDED.active_claim_id,
            status = 'active',
            replaced_by_claim_id = NULL,
            updated_at = NOW()
        `,
        [input.project_id, input.subject_id, slot, input.claim_id],
      );

      await client.query("COMMIT");
      return claimResult.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getClaim(args: { project_id: string; claim_id: string }): Promise<Claim | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM claims
        WHERE project_id = $1
          AND claim_id = $2
        LIMIT 1
      `,
      [args.project_id, args.claim_id],
    );
    return result.rows[0] || null;
  }

  async getAssertionsForClaim(args: { project_id: string; claim_id: string }): Promise<ClaimAssertion[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM claim_assertions
        WHERE project_id = $1
          AND claim_id = $2
        ORDER BY last_seen_at DESC
      `,
      [args.project_id, args.claim_id],
    );
    return result.rows;
  }

  async getEdgesForClaim(args: { project_id: string; claim_id: string }): Promise<ClaimEdge[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM claim_edges
        WHERE project_id = $1
          AND (from_claim_id = $2 OR to_claim_id = $2)
        ORDER BY created_at DESC
      `,
      [args.project_id, args.claim_id],
    );
    return result.rows;
  }

  async getCurrentTruth(args: { project_id: string; subject_id: string }): Promise<ResolvedTruthSlot[]> {
    const result = await this.pool.query(
      `
        SELECT
          ss.slot,
          ss.active_claim_id,
          c.predicate,
          c.object_value,
          c.claim_type,
          c.confidence,
          c.tags,
          ss.updated_at,
          c.source_memory_id,
          c.source_observation_id
        FROM slot_state ss
        INNER JOIN claims c
          ON c.project_id = ss.project_id
         AND c.claim_id = ss.active_claim_id
        WHERE ss.project_id = $1
          AND ss.subject_id = $2
          AND ss.status = 'active'
          AND c.status = 'active'
        ORDER BY ss.updated_at DESC
      `,
      [args.project_id, args.subject_id],
    );
    return result.rows;
  }

  async getCurrentSlot(args: {
    project_id: string;
    subject_id: string;
    slot: string;
  }): Promise<ResolvedTruthSlot | null> {
    const result = await this.pool.query(
      `
        SELECT
          ss.slot,
          ss.active_claim_id,
          c.predicate,
          c.object_value,
          c.claim_type,
          c.confidence,
          c.tags,
          ss.updated_at,
          c.source_memory_id,
          c.source_observation_id
        FROM slot_state ss
        INNER JOIN claims c
          ON c.project_id = ss.project_id
         AND c.claim_id = ss.active_claim_id
        WHERE ss.project_id = $1
          AND ss.subject_id = $2
          AND ss.slot = $3
          AND ss.status = 'active'
          AND c.status = 'active'
        LIMIT 1
      `,
      [args.project_id, args.subject_id, args.slot],
    );
    return result.rows[0] || null;
  }

  async getSlots(args: {
    project_id: string;
    subject_id: string;
    limit: number;
  }): Promise<Array<ResolvedTruthSlot & { status: string }>> {
    const limit = clampInt(args.limit, 1, 500, 100);
    const result = await this.pool.query(
      `
        SELECT
          ss.slot,
          ss.active_claim_id,
          COALESCE(c.predicate, '') AS predicate,
          COALESCE(c.object_value, '') AS object_value,
          COALESCE(c.claim_type, '') AS claim_type,
          COALESCE(c.confidence, 0) AS confidence,
          COALESCE(c.tags, '{}') AS tags,
          ss.updated_at,
          c.source_memory_id,
          c.source_observation_id,
          ss.status
        FROM slot_state ss
        LEFT JOIN claims c
          ON c.project_id = ss.project_id
         AND c.claim_id = ss.active_claim_id
        WHERE ss.project_id = $1
          AND ss.subject_id = $2
        ORDER BY ss.updated_at DESC
        LIMIT $3
      `,
      [args.project_id, args.subject_id, limit],
    );
    return result.rows;
  }

  async getClaimGraph(args: {
    project_id: string;
    subject_id: string;
    limit: number;
  }): Promise<{ claims: Claim[]; edges: ClaimEdge[] }> {
    const limit = clampInt(args.limit, 1, 200, 50);
    const claimResult = await this.pool.query(
      `
        SELECT *
        FROM claims
        WHERE project_id = $1
          AND subject_id = $2
        ORDER BY asserted_at DESC
        LIMIT $3
      `,
      [args.project_id, args.subject_id, limit],
    );
    const claims = claimResult.rows as Claim[];
    if (claims.length === 0) return { claims: [], edges: [] };

    const claimIds = claims.map((c) => c.claim_id);
    const edgeResult = await this.pool.query(
      `
        SELECT *
        FROM claim_edges
        WHERE project_id = $1
          AND (from_claim_id = ANY($2::text[]) OR to_claim_id = ANY($2::text[]))
        ORDER BY created_at DESC
      `,
      [args.project_id, claimIds],
    );

    return { claims, edges: edgeResult.rows };
  }

  async getClaimHistory(args: {
    project_id: string;
    subject_id: string;
    slot?: string | null;
    limit: number;
  }): Promise<{ claims: Claim[]; edges: ClaimEdge[]; by_slot: Record<string, Claim[]> }> {
    const limit = clampInt(args.limit, 1, 500, 100);
    const hasSlot = !!(args.slot && String(args.slot).trim());
    const claimResult = await this.pool.query(
      `
        SELECT *
        FROM claims
        WHERE project_id = $1
          AND subject_id = $2
          AND ($3::boolean = FALSE OR slot = $4)
        ORDER BY asserted_at DESC
        LIMIT $5
      `,
      [args.project_id, args.subject_id, hasSlot, args.slot || null, limit],
    );
    const claims = claimResult.rows as Claim[];
    const claimIds = claims.map((c) => c.claim_id);

    const bySlot: Record<string, Claim[]> = {};
    for (const claim of claims) {
      const slot = claim.slot || "_unknown";
      if (!bySlot[slot]) bySlot[slot] = [];
      bySlot[slot].push(claim);
    }

    if (claimIds.length === 0) return { claims, edges: [], by_slot: bySlot };

    const edgeResult = await this.pool.query(
      `
        SELECT *
        FROM claim_edges
        WHERE project_id = $1
          AND edge_type = 'supersedes'
          AND (from_claim_id = ANY($2::text[]) OR to_claim_id = ANY($2::text[]))
        ORDER BY created_at DESC
      `,
      [args.project_id, claimIds],
    );

    return { claims, edges: edgeResult.rows, by_slot: bySlot };
  }

  async retractClaim(args: {
    project_id: string;
    claim_id: string;
    reason: string;
  }): Promise<{
    success: boolean;
    claim_id: string;
    slot: string;
    previous_claim_id: string | null;
    restored_previous: boolean;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const currentResult = await client.query(
        `
          SELECT *
          FROM claims
          WHERE project_id = $1
            AND claim_id = $2
          LIMIT 1
        `,
        [args.project_id, args.claim_id],
      );
      const claim = currentResult.rows[0] as Claim | undefined;
      if (!claim) {
        await client.query("ROLLBACK");
        return {
          success: false,
          claim_id: args.claim_id,
          slot: "",
          previous_claim_id: null,
          restored_previous: false,
        };
      }

      await client.query(
        `
          UPDATE claims
          SET status = 'retracted',
              retracted_at = NOW(),
              retract_reason = $3
          WHERE project_id = $1
            AND claim_id = $2
        `,
        [args.project_id, args.claim_id, args.reason],
      );

      const previousResult = await client.query(
        `
          SELECT claim_id
          FROM claims
          WHERE project_id = $1
            AND subject_id = $2
            AND slot = $3
            AND status = 'active'
            AND claim_id <> $4
          ORDER BY asserted_at DESC
          LIMIT 1
        `,
        [args.project_id, claim.subject_id, claim.slot, args.claim_id],
      );
      const previous = previousResult.rows[0]?.claim_id || null;

      await client.query(
        `
          INSERT INTO slot_state (
            project_id, subject_id, slot, active_claim_id, status, replaced_by_claim_id
          )
          VALUES (
            $1, $2, $3, $4, $5, $6
          )
          ON CONFLICT (project_id, subject_id, slot)
          DO UPDATE SET
            active_claim_id = EXCLUDED.active_claim_id,
            status = EXCLUDED.status,
            replaced_by_claim_id = EXCLUDED.replaced_by_claim_id,
            updated_at = NOW()
        `,
        [
          args.project_id,
          claim.subject_id,
          claim.slot,
          previous,
          previous ? "active" : "retracted",
          args.claim_id,
        ],
      );

      if (previous) {
        await client.query(
          `
            INSERT INTO claim_edges (
              project_id, subject_id, from_claim_id, to_claim_id, edge_type, weight, reason_code, reason_text
            )
            VALUES ($1, $2, $3, $4, 'retracts', 1, 'manual_retraction', $5)
            ON CONFLICT (project_id, from_claim_id, to_claim_id, edge_type) DO NOTHING
          `,
          [args.project_id, claim.subject_id, args.claim_id, previous, args.reason],
        );
      }

      await client.query("COMMIT");
      return {
        success: true,
        claim_id: args.claim_id,
        slot: claim.slot,
        previous_claim_id: previous,
        restored_previous: !!previous,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

}

export type { CoreStore, CreateClaimInput, CreateMemoryInput, UpdateMemoryInput };
