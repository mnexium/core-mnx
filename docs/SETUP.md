# 🚀 Setup and Initialization

This guide helps you get CORE running quickly, then validates that memory + claim routes are working end-to-end.

## 🧭 Choose Your Path

- **Path A (Recommended):** local Docker Postgres + live web dashboard + interactive route testing.
- **Path B:** one-shot Docker-backed E2E script.

> ✅ If you are starting from scratch, use **Path A** first.

## ✅ Prerequisites

- Node.js 18+ (Node 20+ recommended)
- Postgres 14+ (15+ recommended)
- `psql` CLI
- Docker (optional, required for Path A and Path B)

Required Postgres extension:

- `pgvector`

## ⚙️ Quick Local Bootstrap

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Apply schema (required, no auto-init at startup):

```bash
psql "postgresql://USER:PASSWORD@HOST:5432/DB" \
  -f sql/postgres/schema.sql
```

4. Start CORE:

```bash
npm run dev
```

5. Check health:

```bash
curl -s http://localhost:8080/health
```

Expected shape:

```json
{"ok":true,"service":"mnexium-core","timestamp":"..."}
```

## 🐳 Path A (Recommended): Dashboard + Persistent Docker DB

1. Start Postgres:

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

3. Configure `.env` (minimum fields):

```dotenv
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=mnexium_core
POSTGRES_USER=mnexium
POSTGRES_PASSWORD=mnexium_dev_password
CORE_DEFAULT_PROJECT_ID=default-project
PORT=8080
CORE_AI_MODE=simple
USE_RETRIEVAL_EXPAND=false
CORE_DEBUG=false
```

4. Start CORE:

```bash
npm run dev
```

5. Start dashboard in a second terminal:

```bash
npm run e2e:web
```

6. Open dashboard:

- `http://127.0.0.1:8091`

Suggested dashboard values:

- Core Base URL: `http://127.0.0.1:8080`
- Project ID: `default-project`
- Subject ID: `user_web_e2e`
- Postgres Host: `127.0.0.1`
- Postgres Port: `5432`
- Postgres DB: `mnexium_core`
- Postgres User: `mnexium`
- Postgres Password: `mnexium_dev_password`

## 🧪 Path B: One-shot Docker E2E

Run:

```bash
npm run e2e
```

Keep DB container after run:

```bash
CORE_E2E_KEEP_DB=true npm run e2e
```

What this script does:

- boots Docker Postgres
- applies `sql/postgres/schema.sql`
- starts CORE on a temporary port (default `18080`)
- runs route suite
- tears down server and DB (unless keep flag is true)

### E2E env overrides

- `CORE_E2E_DB_CONTAINER` (default `mnx-core-e2e-db`)
- `CORE_E2E_DB_IMAGE` (default `pgvector/pgvector:pg16`)
- `CORE_E2E_DB_PORT` (default `5432`)
- `CORE_E2E_DB_NAME` (default `mnexium_core`)
- `CORE_E2E_DB_USER` (default `mnexium`)
- `CORE_E2E_DB_PASSWORD` (default `mnexium_dev_password`)
- `CORE_E2E_SERVER_PORT` (default `18080`)
- `CORE_E2E_PROJECT_ID` (default `default-project`)
- `CORE_E2E_KEEP_DB` (default `false`)

## 🌐 Dashboard env overrides (`npm run e2e:web`)

- `CORE_E2E_WEB_PORT` (default `8091`)
- `CORE_E2E_WEB_HOST` (default `127.0.0.1`)
- `CORE_E2E_BASE_URL` (default `http://127.0.0.1:${PORT||8080}`)
- `CORE_E2E_PROJECT_ID` (default `CORE_DEFAULT_PROJECT_ID` or `default-project`)
- `CORE_E2E_SUBJECT_ID` (default `user_web_e2e`)
- `CORE_E2E_WEB_DB_HOST` (default `127.0.0.1`)
- `CORE_E2E_WEB_DB_PORT` (default `5432`)
- `CORE_E2E_WEB_DB_NAME` (default `mnexium_core`)
- `CORE_E2E_WEB_DB_USER` (default `mnexium`)
- `CORE_E2E_WEB_DB_PASSWORD` (default `mnexium_dev_password`)

## 🔐 Environment Reference

### Database

- `POSTGRES_HOST` (required)
- `POSTGRES_PORT` (optional, default `5432`)
- `POSTGRES_DB` (required)
- `POSTGRES_USER` (required)
- `POSTGRES_PASSWORD` (required)

### Server

- `PORT` (optional, default `8080`)
- `CORE_DEFAULT_PROJECT_ID` (optional)

Note:

- In `src/dev.ts`, when `CORE_DEFAULT_PROJECT_ID` is unset, startup uses `default-project`.

### AI routing and retrieval

- `CORE_AI_MODE` (optional, default `auto`)
  - `auto`: Cerebras if `CEREBRAS_API` exists, else OpenAI if `OPENAI_API_KEY` exists, else `simple`
  - `cerebras`: requires `CEREBRAS_API`; if missing, falls back to `simple`
  - `openai`: requires `OPENAI_API_KEY`; if missing, falls back to `simple`
  - `simple`: no LLM client
- `USE_RETRIEVAL_EXPAND` (optional, default `true`)
  - controls `/api/v1/memories/search` expansion/rerank path only
- `RETRIEVAL_MODEL` (optional)
  - model id passed to selected LLM provider

### Provider keys

- `CEREBRAS_API` (required to use Cerebras mode)
- `OPENAI_API_KEY` (required for OpenAI chat mode and embeddings)
- `OPENAI_EMBED_MODEL` (optional, default `text-embedding-3-small`)

## 🧯 Troubleshooting

### `project_id_required`

Cause:

- neither `x-project-id` header nor server default project is available.

Fix:

- set `CORE_DEFAULT_PROJECT_ID`, or send `x-project-id` per request.

### `vector` / `pgvector` errors during schema apply

Cause:

- `pgvector` extension is not available in your Postgres instance.

Fix:

- install/enable `pgvector`, then re-run schema apply.

### Search works but feels lexical-only

Cause:

- embeddings are unavailable (often missing `OPENAI_API_KEY`).

Fix:

- add `OPENAI_API_KEY`, or keep lexical fallback intentionally for local/simple mode.
