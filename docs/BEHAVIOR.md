# 🧠 Runtime Behavior

This document explains how CORE decides retrieval/extraction behavior at runtime and how memory + claim state changes flow through the system.

## 🏗️ Request Lifecycle

CORE server path:

1. Receive HTTP request
2. Resolve `project_id`
3. Dispatch route handler
4. Execute storage contract (`CoreStore`)
5. Return JSON (or SSE stream)

Primary implementation files:

- `src/server/createCoreServer.ts`
- `src/adapters/postgres/PostgresCoreStore.ts`
- `src/ai/recallService.ts`
- `src/ai/memoryExtractionService.ts`

## 🤖 AI Provider Resolution

Configured by `CORE_AI_MODE`:

- `auto` (default)
- `cerebras`
- `openai`
- `simple`

Resolution behavior (`src/dev.ts`):

- `auto`
  - use Cerebras when `CEREBRAS_API` exists
  - else use OpenAI when `OPENAI_API_KEY` exists
  - else use `simple`
- `cerebras`
  - requires `CEREBRAS_API`
  - if missing, warns and falls back to `simple`
  - does not auto-switch to OpenAI
- `openai`
  - requires `OPENAI_API_KEY`
  - if missing, warns and falls back to `simple`
  - does not auto-switch to Cerebras
- `simple`
  - no LLM client

`RETRIEVAL_MODEL` is passed to the selected LLM client.

## 🔎 Retrieval Behavior (`GET /api/v1/memories/search`)

### Retrieval toggle

`USE_RETRIEVAL_EXPAND=true|false`:

- `true`
  - with LLM client: classify + expand + rerank path
  - without LLM client: simple path
- `false`
  - always simple search path
  - extraction endpoint can still use LLM if an LLM client exists

### Query mode semantics (`broad|direct|indirect`)

Mode is produced by an LLM classifier in `src/ai/recallService.ts`.

- `broad`
  - intent: profile/summary requests
  - behavior: list active memories and sort by importance + recency
  - output pattern: wider profile set (`max(limit, 20)`)
- `direct`
  - intent: specific fact lookup
  - behavior: search with hints, then boost claim-backed memories when predicates match truth slots
  - output pattern: high-precision, usually narrow (often top 5)
- `indirect`
  - intent: advice/planning where personal context helps
  - behavior: query expansion + larger candidate pool + rerank when needed
  - output pattern: context-rich supporting memories

Classification fallback behavior:

- classify failure/invalid mode -> defaults to `indirect`
- empty query -> no memories returned

### LLM expanded pipeline

1. Classify query into `broad|direct|indirect` and extract hints/predicates.
2. Build query set:
   - `broad`: profile listing path (no multi-query expansion)
   - `direct`: original + search hints
   - `indirect`: original + search hints + expanded queries
3. For each query, search with embedding (if available) plus lexical fallback.
4. Merge and dedupe by memory ID.
5. Apply mode-specific ranking:
   - `direct`: claim/truth boosts, rerank only when needed
   - `indirect`: rerank via LLM when candidate set exceeds limit

Other runtime constraints:

- conversation context is capped to last 5 items
- classify timeout is 2s
- rerank timeout is 3s

Response fields include:

- `engine` (`provider:model` or `simple`)
- `mode` (`broad|direct|indirect|simple`)
- `used_queries`
- `predicates`

### Simple retrieval pipeline

1. Run single query search.
2. Use embedding if available, otherwise lexical-only path.
3. Rank via adapter scoring.

No LLM classify/expand/rerank is applied.

## ✂️ Extraction Behavior (`POST /api/v1/memories/extract`)

This endpoint is always available.

- With LLM client:
  - uses extraction prompt
  - normalizes output
  - falls back to simple extraction on parse/failure
- Without LLM client:
  - uses simple heuristic extraction directly

Learn modes:

- `learn=false` (default): extraction-only response
- `learn=true`: writes memories/claims and emits `memory.created` per learned memory

## 🗂️ Memory Lifecycle Semantics

### Create memory (`POST /api/v1/memories`)

- writes one `memories` row
- optional embedding generation
- duplicate guard when embedding similarity >= 85
- conflict supersede when embedding similarity is in `[60, 85)`
- emits `memory.created`
- emits `memory.superseded` for superseded conflicting memories
- optional async claim extraction (`extract_claims=true` by default)

Notes:

- async extraction is skipped when `no_supersede=true`
- extracted claims link back via `source_memory_id`

### Update memory (`PATCH /api/v1/memories/:id`)

- patch updates supported fields
- emits `memory.updated`

### Delete memory (`DELETE /api/v1/memories/:id`)

- soft delete (`is_deleted=true`)
- emits `memory.deleted` when delete actually occurs

### Restore memory (`POST /api/v1/memories/:id/restore`)

- sets `status='active'`, clears `superseded_by`
- emits `memory.updated`
- deleted memories cannot be restored

### Superseded listing (`GET /api/v1/memories/superseded`)

- returns non-deleted memories where `status='superseded'`

## 🧩 Claim Semantics

### Create claim (`POST /api/v1/claims`)

- inserts into `claims`
- inserts assertion row in `claim_assertions`
- upserts `slot_state` active winner for claim slot

### Retract claim (`POST /api/v1/claims/:id/retract`)

- sets claim status to `retracted`
- restores previous active claim in same slot when available
- updates `slot_state`
- writes `retracts` edge when prior winner is restored

### Truth/slot reads

- truth + slot endpoints resolve from `slot_state` joined with active `claims`
- graph/history endpoints return claims + edges

## 📡 SSE Event Behavior

Endpoint:

- `GET /api/v1/events/memories`

Event types:

- `connected`
- `heartbeat` (every 30s)
- `memory.created`
- `memory.superseded`
- `memory.updated`
- `memory.deleted`

Topology:

- in-process event bus (`src/server/memoryEventBus.ts`)
- no cross-instance fanout by default
- for horizontal scale, replace bus with external pub/sub (Redis/NATS/Kafka)

## ⚠️ Error and Degradation Model

Status pattern:

- `400` validation/input issues
- `404` missing resource or route
- `500` unexpected server error

Graceful degradation:

- no embedding key -> non-vector retrieval path still works
- no LLM client or LLM failure -> simple retrieval/extraction fallback
