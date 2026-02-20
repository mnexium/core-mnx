# API Reference

All routes (except `/health`) require project context.

Project context resolution:

1. `x-project-id` header
2. fallback to `CORE_DEFAULT_PROJECT_ID` if set

If missing, request fails with `400 project_id_required`.

## Health

### GET `/health`

Returns service liveness:

```json
{
  "ok": true,
  "service": "mnexium-core",
  "timestamp": "..."
}
```

## Memory events (SSE)

### GET `/api/v1/events/memories`

Query params:

- `subject_id` (optional)

Event stream:

- `connected`
- `heartbeat`
- `memory.created`
- `memory.superseded`
- `memory.updated`
- `memory.deleted`

## Memories

### GET `/api/v1/memories`

Query params:

- `subject_id` (required)
- `limit` (default `50`, max `200`)
- `offset` (default `0`)
- `include_deleted` (`true|false`)
- `include_superseded` (`true|false`)

Returns:

- `{ data: Memory[], count: number }`

### POST `/api/v1/memories`

Body:

- `subject_id` (required)
- `text` (required)
- `kind` (optional)
- `visibility` (optional)
- `importance` (optional)
- `confidence` (optional)
- `is_temporal` (optional)
- `tags` (optional)
- `metadata` (optional)
- `source_type` (optional)
- `id` (optional)
- `extract_claims` (optional, default `true`)
- `no_supersede` (optional, default `false`)

Returns:

- `201` `{ id, subject_id, text, kind, created: true, superseded_count, superseded_ids }`
- `200` duplicate skip `{ id: null, subject_id, text, kind, created: false, skipped: true, reason: "duplicate" }`

### GET `/api/v1/memories/search`

Query params:

- `subject_id` (required)
- `q` (required)
- `limit` (default `25`, max `200`)
- `min_score` (default `30`)
- `distance` (alias for `min_score`)
- `context` (repeatable; optional conversation context items)

Returns:

- `{ data, query, count, engine, mode, used_queries, predicates }` in expanded mode
- `{ data, query, count, engine }` in fallback path

### POST `/api/v1/memories/extract`

Body:

- `subject_id` (required)
- `text` (required)
- `force` (`boolean`, optional)
- `learn` (`boolean`, optional)
- `conversation_context` (`string[]`, optional)

Query params:

- `learn=true|false` (optional override)
- `force=true|false` (optional override)

Behavior:

- `learn=false` (default): extraction only
- `learn=true`: also inserts memories/claims

Returns (non-learn):

- `{ ok: true, learned: false, mode, extracted_count, memories }`

Returns (learn):

- `{ ok: true, learned: true, mode, extracted_count, learned_memory_count, learned_claim_count, memories }`

### GET `/api/v1/memories/superseded`

Query params:

- `subject_id` (required)
- `limit` (default `50`, max `200`)
- `offset` (default `0`)

Returns:

- `{ data: Memory[], count }`

### GET `/api/v1/memories/recalls`

Query params:

- `chat_id` OR `memory_id` (one required)
- `stats=true|false` (used with `memory_id`)
- `limit` (default `100`, max `1000`)

Returns:

- by chat: `{ data, count, chat_id }`
- by memory: `{ data, count, memory_id }`
- stats: `{ memory_id, stats }`

### GET `/api/v1/memories/:id`

Returns:

- `{ data: Memory }`
- `404` `memory_not_found` or `memory_deleted`

### PATCH `/api/v1/memories/:id`

Body (any subset):

- `text`, `kind`, `visibility`, `importance`, `confidence`, `is_temporal`, `tags`, `metadata`

Returns:

- `{ id, updated: true }`
- `404` `memory_not_found` or `memory_deleted`

### DELETE `/api/v1/memories/:id`

Soft-delete.

Returns:

- `{ ok: true, deleted: boolean }`

### GET `/api/v1/memories/:id/claims`

Returns assertion-centric view:

- `{ data: [{ id, predicate, type, value, confidence, status, first_seen_at, last_seen_at }], count }`

### POST `/api/v1/memories/:id/restore`

Returns:

- `{ ok: true, restored: true, id, subject_id, text }`
- `{ ok: true, restored: false, message: "Memory is already active" }`
- `400` `memory_deleted`
- `404` `memory_not_found`

## Claims

### POST `/api/v1/claims`

Body:

- `subject_id` (required)
- `predicate` (required)
- `object_value` (required)
- `claim_type`, `slot`, `confidence`, `importance`, `tags`, `source_memory_id`, `source_observation_id`, `subject_entity`, `valid_from`, `valid_until` (optional)

Returns:

- `{ claim_id, subject_id, predicate, object_value, slot, claim_type, confidence, observation_id, linking_triggered }`

### POST `/api/v1/claims/:id/retract`

Body:

- `reason` (optional)

Returns:

- `{ success, claim_id, slot, previous_claim_id, restored_previous, reason }`

### GET `/api/v1/claims/:id`

Returns:

- `{ claim, assertions, edges, supersession_chain }`

### GET `/api/v1/claims/subject/:subjectId/truth`

Query params:

- `include_source=true|false` (default `true`)

Returns:

- `{ subject_id, project_id, slot_count, slots }`

### GET `/api/v1/claims/subject/:subjectId/slot/:slot`

Returns:

- `{ subject_id, project_id, slot, active_claim_id, predicate, object_value, claim_type, confidence, updated_at, tags, source }`
- `404` for missing slot

### GET `/api/v1/claims/subject/:subjectId/slots`

Query params:

- `limit` (default `100`, max `500`)

Returns grouped slot state:

- `{ subject_id, total, active_count, slots: { active, superseded, other } }`

### GET `/api/v1/claims/subject/:subjectId/graph`

Query params:

- `limit` (default `50`, max `200`)

Returns:

- `{ subject_id, claims_count, edges_count, edges_by_type, claims, edges }`

### GET `/api/v1/claims/subject/:subjectId/history`

Query params:

- `slot` (optional)
- `limit` (default `100`, max `500`)

Returns:

- `{ subject_id, project_id, slot_filter, by_slot, edges, total_claims }`

## Error conventions

Common response shapes:

- validation error:
  - `{ error: "field_required" }`
- not found:
  - `{ error: "resource_not_found" }`
- server error:
  - `{ error: "server_error", message: "..." }`

Status usage:

- `200` success
- `201` created
- `400` invalid/missing input
- `404` missing resource
- `500` unexpected failure
