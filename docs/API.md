# 📘 API Reference

All routes except `GET /health` require project context.

Project context resolution:

1. `x-project-id` header
2. fallback project id configured on server startup

If neither is available, the request fails with `400`:

```json
{
  "error": "project_id_required",
  "message": "Provide x-project-id header or configure defaultProjectId"
}
```

## 🩺 Health

### GET `/health`

Returns service liveness:

```json
{
  "ok": true,
  "service": "mnexium-core",
  "timestamp": "..."
}
```

## 📡 Memory Events (SSE)

### GET `/api/v1/events/memories`

Query params:

- `subject_id` (optional)

Event types:

- `connected`
- `heartbeat`
- `memory.created`
- `memory.superseded`
- `memory.updated`
- `memory.deleted`

## 🧠 Memories

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
- `text` (required, max length `10000`)
- `kind`, `visibility`, `importance`, `confidence`, `is_temporal`, `tags`, `metadata`, `source_type` (optional)
- `id` (optional)
- `extract_claims` (optional, default `true`)
- `no_supersede` (optional, default `false`)

Returns:

- `201` created:
  - `{ id, subject_id, text, kind, created: true, superseded_count, superseded_ids }`
- `200` duplicate skip:
  - `{ id: null, subject_id, text, kind, created: false, skipped: true, reason: "duplicate" }`

### GET `/api/v1/memories/search`

Query params:

- `subject_id` (required)
- `q` (required)
- `limit` (default `25`, max `200`)
- `min_score` (default `30`)
- `distance` (alias of `min_score`)
- `context` (repeatable; optional conversation context items)

Returns:

- when recall service is configured (default in `src/dev.ts`):
  - `{ data, query, count, engine, mode, used_queries, predicates }`
- internal fallback path:
  - `{ data, query, count, engine }`

### POST `/api/v1/memories/extract`

Body:

- `subject_id` (required)
- `text` (required)
- `force` (`boolean`, optional)
- `learn` (`boolean`, optional)
- `conversation_context` (`string[]`, optional)

Query params:

- `learn=true|false` (optional)
- `force=true|false` (optional)

`learn`/`force` are enabled when either body or query sets them to `true`.

Returns (extraction only):

- `{ ok: true, learned: false, mode, extracted_count, memories }`

Returns (learn/write path):

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
- `stats=true|false` (used only with `memory_id` path)
- `limit` (default `100`, max `1000`)

Response modes:

- by chat (`chat_id` provided): `{ data, count, chat_id }`
- by memory (`memory_id` + no stats): `{ data, count, memory_id }`
- memory stats (`memory_id` + `stats=true`): `{ memory_id, stats }`

Note:

- if both `chat_id` and `memory_id` are provided, `chat_id` path is used.

### GET `/api/v1/memories/:id`

Returns:

- `{ data: Memory }`
- `404` with `memory_not_found` or `memory_deleted`

### PATCH `/api/v1/memories/:id`

Body (any subset):

- `text`, `kind`, `visibility`, `importance`, `confidence`, `is_temporal`, `tags`, `metadata`

Returns:

- `{ id, updated: true }`
- `404` with `memory_not_found` or `memory_deleted`

### DELETE `/api/v1/memories/:id`

Soft delete.

Returns:

- `{ ok: true, deleted: boolean }`

### GET `/api/v1/memories/:id/claims`

Returns assertion-centric claims linked to memory:

- `{ data: [{ id, predicate, type, value, confidence, status, first_seen_at, last_seen_at }], count }`

Errors:

- `404` `memory_not_found`
- `404` `memory_deleted`

### POST `/api/v1/memories/:id/restore`

Returns:

- `{ ok: true, restored: true, id, subject_id, text }`
- `{ ok: true, restored: false, message: "Memory is already active" }`
- `400` `memory_deleted`
- `404` `memory_not_found`

## 🧩 Claims

### POST `/api/v1/claims`

Body:

- required: `subject_id`, `predicate`, `object_value`
- optional: `claim_id`, `claim_type`, `slot`, `confidence`, `importance`, `tags`, `source_memory_id`, `source_observation_id`, `subject_entity`, `valid_from`, `valid_until`

Returns:

- `{ claim_id, subject_id, predicate, object_value, slot, claim_type, confidence, observation_id, linking_triggered }`

### POST `/api/v1/claims/:id/retract`

Body:

- `reason` (optional, default `manual_retraction`)

Returns:

- `{ success, claim_id, slot, previous_claim_id, restored_previous, reason }`

### GET `/api/v1/claims/:id`

Returns:

- `{ claim, assertions, edges, supersession_chain }`

Notes:

- `claim` excludes embedding field
- `supersession_chain` is filtered from `edges` where `edge_type = supersedes`

### GET `/api/v1/claims/subject/:subjectId/truth`

Query params:

- `include_source=true|false` (default `true`)

Returns:

- `{ subject_id, project_id, slot_count, slots }`

### GET `/api/v1/claims/subject/:subjectId/slot/:slot`

Returns:

- `{ subject_id, project_id, slot, active_claim_id, predicate, object_value, claim_type, confidence, updated_at, tags, source }`
- `404` `slot_not_found`

### GET `/api/v1/claims/subject/:subjectId/slots`

Query params:

- `limit` (default `100`, max `500`)

Returns grouped slot states:

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

## ⚠️ Error Conventions

Common error payloads:

- validation: `{ error: "subject_id_required" }`, `{ error: "q_required" }`, `{ error: "invalid_json_body" }`
- not found: `{ error: "memory_not_found" }`, `{ error: "claim_not_found" }`, `{ error: "slot_not_found" }`, `{ error: "not_found" }`
- server error: `{ error: "server_error", message: "..." }`

Status codes:

- `200` success
- `201` created
- `400` validation/input
- `404` not found
- `500` unexpected server error
