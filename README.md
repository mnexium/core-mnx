# 🧠 CORE

CORE is Mnexium's memory engine: a Postgres-backed HTTP service for durable memory, claim extraction, truth-state resolution, and retrieval for LLM applications.

It is built to run standalone and integrate cleanly into existing platform stacks.

## ✨ Why LLM App Teams Use CORE

- **Grounded outputs:** retrieve durable user memory instead of relying only on short chat context.
- **Persistent personalization:** keep preferences, history, and decisions across sessions/channels.
- **Lower hallucination risk:** combine memory retrieval with claim/slot truth state.
- **Context-window relief:** recall important memory on demand without re-prompting everything.
- **Faster shipping:** use a ready memory/truth backend instead of building custom memory infra.

## 🔩 What CORE Provides

- Memory lifecycle APIs: create, list, search, update, soft-delete, restore.
- Memory extraction from text (`/api/v1/memories/extract`) with optional learning writes.
- Claim APIs with slot-based truth resolution and retraction workflows.
- Retrieval engine with vector + lexical search and LLM-expanded modes.
- SSE stream for memory events (`memory.created`, `memory.superseded`, `memory.updated`, `memory.deleted`).

## 🧱 Core Concepts

- **Memory:** user-scoped durable facts/context.
- **Claim:** structured assertion (`predicate`, `object_value`, metadata).
- **Slot state (`slot_state`):** active winner for a semantic slot.
- **Supersession:** medium-similarity memories can be marked superseded by newer memories.

## 🔎 Retrieval Intelligence

When LLM retrieval expansion is enabled, search classifies queries into:

- **`broad`**: profile/summary recall (importance + recency weighted).
- **`direct`**: specific fact lookup with truth/claim-aware boosts.
- **`indirect`**: advice/planning prompts with expanded query set + rerank.

Fallback behavior is built in:

- missing LLM provider keys -> simple retrieval/extraction mode
- missing embedding key -> non-vector lexical path still works

## ⚙️ Runtime Modes

`CORE_AI_MODE` supports:

- `auto` (default): `cerebras -> openai -> simple`
- `cerebras`: requires `CEREBRAS_API` (else falls back to simple)
- `openai`: requires `OPENAI_API_KEY` (else falls back to simple)
- `simple`: no LLM client

`USE_RETRIEVAL_EXPAND` controls search-time classify/expand/rerank behavior.

## 🚀 Quick Start

Use the setup guide for the complete runbook, Docker path, and environment reference:

- [Setup and initialization](https://github.com/mnexium/core-mnx/blob/main/docs/SETUP.md)

## 🧪 API Surface

Key route groups:

- health: `GET /health`
- memories: `/api/v1/memories*`
- claims/truth: `/api/v1/claims*`
- events: `GET /api/v1/events/memories`

Full endpoint contracts:

- [HTTP endpoints and contracts](https://github.com/mnexium/core-mnx/blob/main/docs/API.md)

## 🛡️ Production Posture

CORE is integration-first. Auth, tenancy policy, idempotency strategy, and event bus scaling are intentionally externalized so you can fit CORE into your existing platform controls.

Production checklist:

- [Production hardening checklist](https://github.com/mnexium/core-mnx/blob/main/docs/OPERATIONS.md)

## 📚 Documentation Map

- ⚙️ Setup and initialization: [docs/SETUP.md](https://github.com/mnexium/core-mnx/blob/main/docs/SETUP.md)
- 🧠 Runtime behavior and decision logic: [docs/BEHAVIOR.md](https://github.com/mnexium/core-mnx/blob/main/docs/BEHAVIOR.md)
- 📘 HTTP endpoints and contracts: [docs/API.md](https://github.com/mnexium/core-mnx/blob/main/docs/API.md)
- 🛠️ Production hardening checklist: [docs/OPERATIONS.md](https://github.com/mnexium/core-mnx/blob/main/docs/OPERATIONS.md)
