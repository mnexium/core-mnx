export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type MemoryStatus = "active" | "superseded";
export type ClaimStatus = "active" | "retracted";
export type SlotStatus = "active" | "superseded" | "retracted";
export type ClaimEdgeType = "supersedes" | "supports" | "duplicates" | "related" | "retracts";

export interface Memory {
  id: string;
  project_id: string;
  subject_id: string;
  text: string;
  kind: "fact" | "preference" | "context" | "note" | "event" | "trait";
  visibility: "private" | "shared" | "public";
  importance: number;
  confidence: number;
  is_temporal: boolean;
  tags: string[];
  metadata: Record<string, Json>;
  status: MemoryStatus;
  superseded_by: string | null;
  is_deleted: boolean;
  source_type: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  seen_count: number;
  reinforcement_count: number;
  last_reinforced_at: string | null;
}

export interface Claim {
  claim_id: string;
  project_id: string;
  subject_id: string;
  predicate: string;
  object_value: string;
  slot: string;
  claim_type: string;
  confidence: number;
  importance: number;
  tags: string[];
  source_memory_id: string | null;
  source_observation_id: string | null;
  subject_entity: string;
  status: ClaimStatus;
  asserted_at: string;
  updated_at: string;
  retracted_at: string | null;
  retract_reason: string | null;
  valid_from: string | null;
  valid_until: string | null;
}

export interface ClaimAssertion {
  assertion_id: string;
  project_id: string;
  subject_id: string;
  claim_id: string;
  memory_id: string | null;
  predicate: string;
  object_type: "string" | "number" | "date" | "json";
  value_string: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: Json | null;
  confidence: number;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ClaimEdge {
  edge_id: number;
  project_id: string;
  subject_id: string;
  from_claim_id: string;
  to_claim_id: string;
  edge_type: ClaimEdgeType;
  weight: number;
  reason_code: string | null;
  reason_text: string | null;
  created_at: string;
}

export interface SlotState {
  project_id: string;
  subject_id: string;
  slot: string;
  active_claim_id: string | null;
  status: SlotStatus;
  replaced_by_claim_id: string | null;
  updated_at: string;
}

export interface ResolvedTruthSlot {
  slot: string;
  active_claim_id: string;
  predicate: string;
  object_value: string;
  claim_type: string;
  confidence: number;
  tags: string[];
  updated_at: string;
  source_memory_id: string | null;
  source_observation_id: string | null;
}

export interface MemoryRecallEvent {
  event_id: string;
  project_id: string;
  subject_id: string;
  memory_id: string;
  memory_text: string;
  chat_id: string;
  message_index: number;
  chat_logged: boolean;
  similarity_score: number;
  request_type: string;
  model: string;
  metadata: Record<string, Json>;
  recalled_at: string;
}

export interface MemoryRecallStats {
  total_recalls: number;
  unique_chats: number;
  unique_subjects: number;
  avg_score: number;
  first_recalled_at: string | null;
  last_recalled_at: string | null;
}
