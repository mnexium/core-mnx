import type {
  Claim,
  ClaimAssertion,
  ClaimEdge,
  Memory,
  MemoryRecallEvent,
  MemoryRecallStats,
  ResolvedTruthSlot,
} from "./types";

export interface CreateMemoryInput {
  id: string;
  project_id: string;
  subject_id: string;
  text: string;
  kind?: Memory["kind"];
  visibility?: Memory["visibility"];
  importance?: number;
  confidence?: number;
  is_temporal?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
  source_type?: string;
  embedding?: number[] | null;
}

export interface UpdateMemoryInput {
  text?: string;
  kind?: Memory["kind"];
  visibility?: Memory["visibility"];
  importance?: number;
  confidence?: number;
  is_temporal?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
  embedding?: number[] | null;
}

export interface CreateClaimInput {
  claim_id: string;
  project_id: string;
  subject_id: string;
  predicate: string;
  object_value: string;
  slot?: string;
  claim_type?: string;
  confidence?: number;
  importance?: number;
  tags?: string[];
  source_memory_id?: string | null;
  source_observation_id?: string | null;
  subject_entity?: string;
  valid_from?: string | null;
  valid_until?: string | null;
  embedding?: number[] | null;
}

export interface CoreStore {
  listMemories(args: {
    project_id: string;
    subject_id: string;
    limit: number;
    offset: number;
    include_deleted?: boolean;
    include_superseded?: boolean;
  }): Promise<Memory[]>;
  searchMemories(args: {
    project_id: string;
    subject_id: string;
    q: string;
    query_embedding: number[] | null;
    limit: number;
    min_score: number;
  }): Promise<Array<Memory & { score: number; effective_score: number }>>;
  createMemory(input: CreateMemoryInput): Promise<Memory>;
  getMemory(args: { project_id: string; id: string }): Promise<Memory | null>;
  getMemoryClaims(args: { project_id: string; memory_id: string }): Promise<ClaimAssertion[]>;
  updateMemory(args: { project_id: string; id: string; patch: UpdateMemoryInput }): Promise<Memory | null>;
  deleteMemory(args: { project_id: string; id: string }): Promise<{ ok: true; deleted: boolean }>;
  listSupersededMemories(args: {
    project_id: string;
    subject_id: string;
    limit: number;
    offset: number;
  }): Promise<Memory[]>;
  restoreMemory(args: { project_id: string; id: string }): Promise<Memory | null>;
  findDuplicateMemory?(args: {
    project_id: string;
    subject_id: string;
    embedding: number[];
    threshold: number;
  }): Promise<{ id: string; similarity: number } | null>;
  findConflictingMemories?(args: {
    project_id: string;
    subject_id: string;
    embedding: number[];
    min_similarity: number;
    max_similarity: number;
    limit: number;
  }): Promise<Array<{ id: string; similarity: number }>>;
  supersedeMemories?(args: {
    project_id: string;
    subject_id: string;
    memory_ids: string[];
    superseded_by: string;
  }): Promise<number>;

  getRecallEventsByChat(args: { project_id: string; chat_id: string }): Promise<MemoryRecallEvent[]>;
  getRecallEventsByMemory(args: { project_id: string; memory_id: string; limit: number }): Promise<MemoryRecallEvent[]>;
  getMemoryRecallStats(args: { project_id: string; memory_id: string }): Promise<MemoryRecallStats>;

  createClaim(input: CreateClaimInput): Promise<Claim>;
  getClaim(args: { project_id: string; claim_id: string }): Promise<Claim | null>;
  getAssertionsForClaim(args: { project_id: string; claim_id: string }): Promise<ClaimAssertion[]>;
  getEdgesForClaim(args: { project_id: string; claim_id: string }): Promise<ClaimEdge[]>;
  getCurrentTruth(args: { project_id: string; subject_id: string }): Promise<ResolvedTruthSlot[]>;
  getCurrentSlot(args: { project_id: string; subject_id: string; slot: string }): Promise<ResolvedTruthSlot | null>;
  getSlots(args: { project_id: string; subject_id: string; limit: number }): Promise<Array<ResolvedTruthSlot & { status: string }>>;
  getClaimGraph(args: { project_id: string; subject_id: string; limit: number }): Promise<{ claims: Claim[]; edges: ClaimEdge[] }>;
  getClaimHistory(args: {
    project_id: string;
    subject_id: string;
    slot?: string | null;
    limit: number;
  }): Promise<{ claims: Claim[]; edges: ClaimEdge[]; by_slot: Record<string, Claim[]> }>;
  retractClaim(args: {
    project_id: string;
    claim_id: string;
    reason: string;
  }): Promise<{
    success: boolean;
    claim_id: string;
    slot: string;
    previous_claim_id: string | null;
    restored_previous: boolean;
  }>;
}
