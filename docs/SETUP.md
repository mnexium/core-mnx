# Setup and Initialization

This document explains how to bootstrap CORE locally or in a fresh environment.

## 1. Prerequisites

- Node.js 18+ (Node 20+ recommended)
- Postgres 14+ (15+ recommended)
- `psql` CLI

Recommended Postgres extensions:

- `pgvector` (required by schema for vector search)

## 2. Install dependencies

```bash
npm --prefix /Users/mariusndini/Documents/GitHub/mnexium.com/CORE install
```

## 3. Create env file

```bash
cp /Users/mariusndini/Documents/GitHub/mnexium.com/CORE/.env.example /Users/mariusndini/Documents/GitHub/mnexium.com/CORE/.env
```

Populate `/Users/mariusndini/Documents/GitHub/mnexium.com/CORE/.env` with values for your environment.

## 4. Create database objects (required)

CORE does not run schema creation automatically at startup.

You must apply:

`/Users/mariusndini/Documents/GitHub/mnexium.com/CORE/sql/postgres/schema.sql`

Example:

```bash
psql "postgresql://USER:PASSWORD@HOST:5432/DB" \
  -f /Users/mariusndini/Documents/GitHub/mnexium.com/CORE/sql/postgres/schema.sql
```

This script creates:

- `memories`
- `claims`
- `claim_assertions`
- `claim_edges`
- `slot_state`
- `memory_recall_events`
- supporting indexes/triggers/extensions

## 5. Start server

```bash
npm --prefix /Users/mariusndini/Documents/GitHub/mnexium.com/CORE run dev
```

Default bind:

- `http://localhost:8080`

## 6. Validate startup

Health endpoint:

```bash
curl -s http://localhost:8080/health
```

Expected:

```json
{"ok":true,"service":"mnexium-core","timestamp":"..."}
```

## Environment variables reference

### Database

- `POSTGRES_HOST` (required)
- `POSTGRES_PORT` (optional, default `5432`)
- `POSTGRES_DB` (required)
- `POSTGRES_USER` (required)
- `POSTGRES_PASSWORD` (required)

### Server

- `PORT` (optional, default `8080`)
- `CORE_DEFAULT_PROJECT_ID` (optional; if omitted, callers must send `x-project-id` header)

### AI routing

- `CORE_AI_MODE` (optional, default `auto`)
  - `auto`: choose `cerebras -> openai -> simple` based on key availability
  - `cerebras`: force Cerebras
  - `openai`: force OpenAI
  - `simple`: force heuristic mode only
- `USE_RETRIEVAL_EXPAND` (optional, default `true`)
  - `true`: use LLM classify/expand/rerank for search (when LLM available)
  - `false`: force simple search path
- `RETRIEVAL_MODEL` (optional)
  - shared model selector for retrieval/extraction LLM calls
  - example Cerebras: `gpt-oss-120b`
  - example OpenAI: `gpt-4o-mini`, `gpt-4.1-mini`

### Provider keys

- `CEREBRAS_API` (required to use Cerebras mode)
- `OPENAI_API_KEY` (required to use OpenAI mode; also used by embeddings provider)
- `OPENAI_EMBED_MODEL` (optional, default `text-embedding-3-small`)
  - schema currently uses `VECTOR(1536)`, so use a 1536-d embedding model

## Project ID handling

Most routes require `project_id` context.

CORE resolves it in this order:

1. `x-project-id` request header
2. `CORE_DEFAULT_PROJECT_ID` from env

If neither exists, route returns:

```json
{
  "error": "project_id_required",
  "message": "Provide x-project-id header or configure defaultProjectId"
}
```

## Common setup notes

### Missing `pgvector`

Symptoms:

- schema apply fails around `vector` type

Fix:

- install `pgvector` for your Postgres instance, then rerun schema file

### Embeddings in non-vector mode

By design, if `OPENAI_API_KEY` is missing, embedding helper returns empty vectors.

Effect:

- write APIs still work
- search falls back to non-vector behavior

### OpenAI mode without key

If `CORE_AI_MODE=openai` and key is missing:

- startup warns
- service falls back to simple mode
