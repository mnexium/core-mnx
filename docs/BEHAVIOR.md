# Runtime Behavior

This document describes how CORE behaves at runtime, including AI mode selection, memory handling, claim semantics, and SSE events.

## High-level architecture

CORE server path:

1. Receive HTTP request
2. Resolve `project_id`
3. Dispatch to route handler
4. Route calls `CoreStore` contract
5. Postgres adapter executes SQL
6. Route returns JSON response

Key implementation files:

- HTTP server: `src/server/createCoreServer.ts`
- Storage adapter: `src/adapters/postgres/PostgresCoreStore.ts`
- AI recall: `src/ai/recallService.ts`
- AI extraction: `src/ai/memoryExtractionService.ts`

## AI mode resolution

Configured by `CORE_AI_MODE`:

- `cerebras`
- `openai`
- `simple`
- `auto` (default)

Provider resolution in `auto`:

1. If `CEREBRAS_API` exists -> Cerebras client
2. Else if `OPENAI_API_KEY` exists -> OpenAI client
3. Else -> simple mode

`RETRIEVAL_MODEL` is passed to the selected LLM provider.

## Retrieval expansion toggle

`USE_RETRIEVAL_EXPAND=true|false`

- `true`
  - if an LLM client exists, search uses LLM mode:
    - classify query (`broad|direct|indirect`)
    - optional query expansion
    - optional reranking
  - if no LLM client exists, simple search path is used
- `false`
  - always uses simple search path, even if LLM keys are present

## Search behavior (`GET /api/v1/memories/search`)

### LLM expanded mode

Flow:

1. classify query mode and hints
2. build query set (original + hints + expansions)
3. search each query with embedding + lexical fallback
   - lexical matching includes whole-phrase and token-level matching
4. merge/deduplicate by memory id
5. direct mode: may boost memory-backed truth facts
6. indirect mode: rerank via LLM

Response includes:

- `engine`: provider+model or `simple`
- `mode`: `broad|direct|indirect|simple`
- `used_queries`
- `predicates`

### Simple mode

Flow:

1. single query search
2. optional embedding if available
3. rank by adapter scoring

No LLM classify/expand/rerank.

## Memory extraction behavior (`POST /api/v1/memories/extract`)

This endpoint is always enabled.

### If LLM client exists

- uses LLM extraction prompt
- normalizes output shape
- if parsing is invalid, continues with simple extraction mode

### If no LLM client

- uses simple heuristic extraction directly

### Learn modes

- default (`learn=false`): extraction-only response, no DB writes
- `learn=true`:
  - creates memories
  - creates claims for each extracted claim
  - emits `memory.created` SSE event per created memory

## Memory lifecycle semantics

### Create memory (`POST /api/v1/memories`)

- writes one `memories` row
- optional embedding
- duplicate guard: skips create when high-similarity duplicate is found
- conflict supersede: marks medium-similarity active memories as superseded
- emits `memory.created`
- emits `memory.superseded` for each superseded memory
- async claim extraction (default on):
  - controlled by `extract_claims` (default `true`)
  - skipped when `no_supersede=true`
  - extracted claims are created with `source_memory_id` pointing to the new memory

### Update memory (`PATCH /api/v1/memories/:id`)

- updates existing row fields
- emits `memory.updated`

### Delete memory (`DELETE /api/v1/memories/:id`)

- soft delete (`is_deleted=true`)
- emits `memory.deleted`

### Restore memory (`POST /api/v1/memories/:id/restore`)

- sets `status='active'` and clears `superseded_by`
- emits `memory.updated`
- if memory already active: returns `restored=false`
- if memory is deleted: returns `memory_deleted`

### Superseded listing

- `GET /api/v1/memories/superseded` reads `status='superseded'`
- create path can auto-supersede based on similarity when embedding is available

## Claim semantics

### Create claim (`POST /api/v1/claims`)

- inserts into `claims`
- creates assertion in `claim_assertions`
- upserts `slot_state` active winner for claim slot

### Retract claim (`POST /api/v1/claims/:id/retract`)

- marks claim as `retracted`
- attempts to restore previous active claim in same slot
- updates `slot_state`
- inserts `retracts` edge when a previous winner is restored

### Truth endpoints

- truth and slot APIs read from `slot_state + claims`
- claim graph/history reads claims and edges

## SSE event behavior

Endpoint:

- `GET /api/v1/events/memories`

Emits:

- `connected` on subscribe
- `heartbeat` every 30s
- `memory.created`
- `memory.updated`
- `memory.deleted`

SSE topology notes:

- In-process event bus only (`src/server/memoryEventBus.ts`)
- Events are not shared across multiple server instances
- For horizontal scale, replace with external pub/sub (Redis, NATS, Kafka, etc.)

## Explicit startup behavior

- Database schema is not auto-created at startup.
- Project context is resolved from `x-project-id` header or configured default.
- Extraction/linking run inline in this service scaffold (no queue required).

## Error handling model

Pattern:

- validation issues -> `400`
- missing resource -> `404`
- unsupported path -> `404`
- unexpected failures -> `500`

Search/extraction are designed to degrade gracefully:

- embedding key unavailable -> non-vector behavior
- LLM unavailable/fails -> simple mode behavior
