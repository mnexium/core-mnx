# Setup and Initialization

This guide covers local bootstrap, required environment setup, validation, and E2E workflows for CORE.

## 1. Prerequisites

- Node.js 18+ (Node 20+ recommended)
- Postgres 14+ (15+ recommended)
- `psql` CLI
- Docker (optional, for E2E and dashboard workflows)

Recommended Postgres extension:

- `pgvector` (required by schema for vector search)


#### Highly reccommend the docker runbook path in Path A
---


## 2. Install dependencies

```bash
npm install
```

## 3. Create `.env`

```bash
cp .env.example .env
```

Populate `.env` with values for your environment.

## 4. Create database objects (required)

CORE does not auto-create schema at startup.

Apply:

`sql/postgres/schema.sql`

Example:

```bash
psql "postgresql://USER:PASSWORD@HOST:5432/DB" \
  -f sql/postgres/schema.sql
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
npm run dev
```

Default bind:

- `http://localhost:8080`

## 6. Validate startup

```bash
curl -s http://localhost:8080/health
```

Expected:

```json
{"ok":true,"service":"mnexium-core","timestamp":"..."}
```

## End-to-end route test

Run the full Docker-backed E2E suite (boots Postgres, applies schema, starts CORE, tests all routes):

```bash
npm run e2e
```

Optional overrides:

- `CORE_E2E_DB_IMAGE` (default `pgvector/pgvector:pg16`)
- `CORE_E2E_DB_PORT` (default `5432`)
- `CORE_E2E_SERVER_PORT` (default `18080`)
- `CORE_E2E_KEEP_DB=true` to keep container after test

## Browser test dashboard

Start the local dashboard:

```bash
npm run e2e:web
```

Then open:

- `http://localhost:8091`

The dashboard lets you:

- input CORE base URL + project/subject IDs
- input Postgres connection settings
- run a live status check for CORE and Postgres
- run the full route suite with step-by-step logs and pass/fail status
- use a `Memories` tab for list/search/create operations
- use a `Routes` tab with one card per API route, prefilled example payloads, and run buttons

Optional web dashboard env vars:

- `CORE_E2E_WEB_PORT` (default `8091`)
- `CORE_E2E_WEB_HOST` (default `127.0.0.1`)
- `CORE_E2E_WEB_DB_HOST` (default `127.0.0.1`)
- `CORE_E2E_WEB_DB_PORT` (default `5432`)
- `CORE_E2E_WEB_DB_NAME` (default `mnexium_core`)
- `CORE_E2E_WEB_DB_USER` (default `mnexium`)
- `CORE_E2E_WEB_DB_PASSWORD` (default `mnexium_dev_password`)

## Exact runbook (copy/paste)

### Path A: Recommended (dashboard + persistent local Docker Postgres)

1. Start Postgres in Docker on port `5432`:

```bash
docker rm -f mnx-core-db >/dev/null 2>&1 || true
docker run -d \
  --name mnx-core-db \
  -e POSTGRES_DB=mnexium_core \
  -e POSTGRES_USER=mnexium \
  -e POSTGRES_PASSWORD=mnexium_dev_password \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

2. Apply schema:

```bash
cat sql/postgres/schema.sql | docker exec -i mnx-core-db psql -U mnexium -d mnexium_core
```

3. Start CORE API (after setting `.env`):

```bash
npm run dev
```

4. Start dashboard in a second terminal:

```bash
npm run e2e:web
```

5. Open dashboard:

```text
http://127.0.0.1:8091
```

6. Dashboard values:

- `Core Base URL`: `http://127.0.0.1:8080`
- `Project ID`: `default-project`
- `Subject ID`: `user_web_e2e`
- `Postgres Host`: `127.0.0.1`
- `Postgres Port`: `5432`
- `Postgres DB`: `mnexium_core`
- `Postgres User`: `mnexium`
- `Postgres Password`: `mnexium_dev_password`

Then click:

- `Check Status`
- `Run Full Route Suite`
- switch to `Memories` tab for list/search/create

### Path B: One-shot Docker E2E script

```bash
npm run e2e
```

To keep the DB container after the run:

```bash
CORE_E2E_KEEP_DB=true npm run e2e
```

Notes:

- `e2e` starts CORE on port `18080` temporarily for the suite, then stops it.
- Use Path A for ongoing dashboard usage.

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
