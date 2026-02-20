# CORE

Mnexium CORE is a Postgres-backed HTTP server scaffold for memories, claims, and memory events.

It is intentionally decoupled from Convex/Clerk/account systems and can run as a standalone service.

## What this is

- A runnable server foundation with a clean storage interface.
- A concrete Postgres adapter (`pg` + `pgvector`) for core entities.
- A configurable retrieval/extraction pipeline that can use Cerebras, OpenAI, or simple fallback mode.
- A process-local SSE event bus for memory events.

## Platform choices

- CORE is intentionally integration-first: auth, access policy, and deployment controls are bring-your-own.
- Database schema is applied explicitly by the operator from `sql/postgres/schema.sql`.

## Documentation map

- Setup and initialization: `docs/SETUP.md`
- Runtime behavior and decision logic: `docs/BEHAVIOR.md`
- HTTP endpoints and contracts: `docs/API.md`
- Production hardening checklist: `docs/OPERATIONS.md`

## Quick start

Run the commands below from `/Users/mariusndini/Documents/GitHub/mnexium.com/CORE`.

1. Install deps:

```bash
npm install
```

2. Create `.env`:

```bash
cp /Users/mariusndini/Documents/GitHub/mnexium.com/CORE/.env.example /Users/mariusndini/Documents/GitHub/mnexium.com/CORE/.env
```

3. Create database objects (required; no auto-init):

```bash
psql "postgresql://USER:PASSWORD@HOST:5432/DB" \
  -f /Users/mariusndini/Documents/GitHub/mnexium.com/CORE/sql/postgres/schema.sql
```

4. Run:

```bash
npm run dev
```

5. Health check:

```bash
curl -s http://localhost:8080/health
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
cat /Users/mariusndini/Documents/GitHub/mnexium.com/CORE/sql/postgres/schema.sql \
| docker exec -i mnx-core-db psql -U mnexium -d mnexium_core
```

3. Start CORE API:

```bash
cat > /Users/mariusndini/Documents/GitHub/mnexium.com/CORE/.env <<'EOF'
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=mnexium_core
POSTGRES_USER=mnexium
POSTGRES_PASSWORD=mnexium_dev_password
CORE_DEFAULT_PROJECT_ID=default-project
PORT=8080
CORE_DEBUG=true
CORE_AI_MODE=simple
USE_RETRIEVAL_EXPAND=false
OPENAI_API_KEY=
CEREBRAS_API=
RETRIEVAL_MODEL=
OPENAI_EMBED_MODEL=text-embedding-3-small
EOF

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

## Required env vars

- `POSTGRES_HOST`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

## Core runtime env vars

- `CORE_DEFAULT_PROJECT_ID` (optional)
- `PORT` (optional)
- `CORE_DEBUG` (`true|false`)
- `CORE_AI_MODE` (`auto|cerebras|openai|simple`)
- `USE_RETRIEVAL_EXPAND` (`true|false`)
- `RETRIEVAL_MODEL` (shared retrieval/extraction model var for the active LLM provider)
- `CEREBRAS_API` (required if using Cerebras mode)
- `OPENAI_API_KEY` (required for OpenAI mode and for embeddings)
- `OPENAI_EMBED_MODEL` (defaults to `text-embedding-3-small`)

See `docs/SETUP.md` and `.env.example` for complete details.
