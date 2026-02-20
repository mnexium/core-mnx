# Operations Playbook

This guide covers how to run CORE confidently in production-like environments and how to extend it for your platform standards.

## Deployment baseline

Recommended baseline:

- 1+ stateless app instances
- managed Postgres with `pgvector`
- reverse proxy/load balancer with tuned timeouts
- centralized logs + metrics

For multi-instance real-time fanout, add external pub/sub (Redis/NATS/Kafka).

## Production integration layers

CORE is designed to plug into your existing platform controls.

Typical additions:

1. Auth and scoped API keys
2. Idempotency keys for write routes
3. External event transport for multi-instance SSE
4. Observability/alerting stack

## Identity and access integration

Current request context is project-based (`x-project-id` or default project).

Production integration:

- API key validation middleware
- per-route scope checks
- tenant boundary enforcement

## Idempotent writes

Write routes may be retried by clients or proxies.

Recommended:

- support `Idempotency-Key` for `POST/PATCH/DELETE`
- persist request/result fingerprints
- return original success response on duplicate keys

## Observability model

Track at minimum:

- request rate and latency (`p50`, `p95`, `p99`)
- response status distribution
- DB query latency/error rate
- LLM provider latency/error rate
- SSE subscriber counts

Add alerts for:

- sustained 5xx error rate
- DB saturation
- high tail latency

## SSE at scale

Current event bus is process-local.

Single-instance:

- full event coverage in one process

Multi-instance:

- use external pub/sub so all subscribers receive all events

## Database operations

## Migration strategy

Recommended:

- versioned SQL migrations
- keep `schema.sql` as bootstrap baseline
- apply schema changes explicitly in CI/CD pipeline

## Backup and recovery

Recommended:

- daily full backups
- point-in-time recovery enabled
- regular restore drills

## Vector index hygiene

For `pgvector` ivfflat indexes:

- run `ANALYZE` after significant ingests
- monitor plans/performance
- tune list count as dataset grows

## Runtime adaptation behavior

CORE keeps responses available under varied key/model configurations.

### LLM provider selection

- `CORE_AI_MODE=auto`:
  - uses Cerebras when key exists
  - else OpenAI when key exists
  - else simple mode

### Retrieval expansion control

- `USE_RETRIEVAL_EXPAND=true`: expanded retrieval flow
- `USE_RETRIEVAL_EXPAND=false`: simple retrieval flow

### Embedding key behavior

- if embedding key is unavailable, write APIs still function
- search continues in non-vector mode

## Data semantics

### Deletion

- memory deletion is soft (`is_deleted=true`)

### Supersession

- modeled via `status` + `superseded_by`
- can be managed by your chosen write workflows/policies

### Truth state

- `slot_state` is authoritative for active slot winners
- claim retraction can restore prior winners

## Suggested implementation order

1. Integrate auth/scopes
2. Add idempotency key support
3. Externalize SSE bus
4. Expand test coverage (integration + load)
5. Add SLO-driven monitoring/alerts
