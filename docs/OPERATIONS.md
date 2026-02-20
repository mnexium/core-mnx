# 🛠️ Operations Playbook

This guide focuses on production hardening for CORE deployments.

## 🧱 Deployment Baseline

Recommended baseline:

- 1+ stateless CORE instances
- managed Postgres with `pgvector`
- reverse proxy/load balancer with tuned upstream timeouts
- centralized logs + metrics

For multi-instance event fanout, add external pub/sub.

## 🔐 Platform Integrations to Add

CORE intentionally leaves platform controls to the host system. Typical production additions:

1. Auth (API keys/JWT) and route-level scopes
2. Tenant boundary checks
3. Idempotency keys for writes
4. External event transport for SSE fanout
5. Alerting + SLO dashboards

## 🔁 Idempotency Guidance

Write routes can be retried by clients/proxies. Add:

- `Idempotency-Key` for `POST/PATCH/DELETE`
- persisted request fingerprint and response body
- replay of original success response for duplicate key

## 📡 SSE at Scale

Current behavior:

- memory events are emitted from an in-process bus
- subscribers connected to instance A will not receive events produced on instance B

Production recommendation:

- publish lifecycle events to Redis/NATS/Kafka
- fan out consistently across all API instances

## 🗄️ Database Operations

### Migrations

- keep `sql/postgres/schema.sql` as bootstrap baseline
- run versioned forward migrations in CI/CD
- avoid startup-time auto-migration in production paths

### Backup and recovery

- daily full backup + PITR
- regular restore drills
- documented recovery RTO/RPO targets

### Vector index hygiene

- run `ANALYZE` after significant ingest batches
- monitor query plans and latency
- tune ivfflat list settings as corpus grows

## 📈 Observability Model

Track:

- request rate and latency (`p50`, `p95`, `p99`)
- status code distribution
- DB query latency/error rate
- LLM provider latency/error rate
- SSE subscriber counts

Alert on:

- sustained 5xx error rate
- DB saturation / connection pool pressure
- high tail latency regressions

## 🤖 Runtime Adaptation (Accuracy Notes)

Provider selection in `src/dev.ts`:

- `CORE_AI_MODE=auto`: Cerebras -> OpenAI -> simple
- `CORE_AI_MODE=cerebras` without key: simple fallback (no OpenAI auto-switch)
- `CORE_AI_MODE=openai` without key: simple fallback (no Cerebras auto-switch)

Retrieval behavior:

- `USE_RETRIEVAL_EXPAND=true`: LLM classify/expand/rerank if LLM exists
- `USE_RETRIEVAL_EXPAND=false`: simple retrieval path

Embedding behavior:

- missing `OPENAI_API_KEY` causes embedder to return empty vectors
- write/read APIs continue; retrieval uses lexical/non-vector scoring path

## 🧾 Data Semantics in Production

- memory deletion is soft (`is_deleted=true`)
- supersession uses `status='superseded'` and `superseded_by`
- truth state is read from `slot_state` joined with active claims
- claim retraction may restore previous slot winner

## ✅ Hardening Checklist

- [ ] Auth + scope middleware in front of CORE routes
- [ ] Explicit tenant/project isolation strategy
- [ ] Idempotency-key storage and replay implemented
- [ ] Externalized SSE/event transport for multi-instance deployments
- [ ] Migration workflow in CI/CD
- [ ] Backup + restore drill cadence defined
- [ ] SLOs + alerts configured
- [ ] Load/perf test against expected traffic profile
