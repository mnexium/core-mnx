# CORE

CORE is Mnexium's memory engine service: a Postgres-backed HTTP API for storing memories, extracting claims, resolving truth state, and retrieving relevant context for downstream applications.

It is designed as an integration-first core service that can run standalone and plug into existing auth, tenancy, and platform controls.

## What CORE does

- Stores subject-scoped memories and supports lifecycle operations (create, update, soft-delete, restore).
- Extracts structured claims from natural language and persists claim assertions.
- Maintains slot-based truth state (`slot_state`) to track active winners and retractions.
- Supports retrieval with vector + lexical fallback and optional LLM-powered query expansion/reranking.
- Streams memory lifecycle events over SSE for real-time consumers.

## Why it is powerful

- Better grounding for responses: LLMs can retrieve durable, user-specific memory instead of relying only on short chat context.
- Lower hallucination risk on known facts: retrieval and claim state give the model a concrete memory substrate to reference.
- Personalization that persists: preferences, history, and prior decisions survive across sessions and channels.
- Works beyond context-window limits: important memory is stored and recalled on demand instead of repeatedly reprompted.
- Faster LLM product development: app teams get a ready memory/truth backend rather than building custom memory pipelines from scratch.

## Intended use

CORE is intended to be the memory and truth substrate behind apps, agents, and workflows that need:

- long-lived user memory,
- auditable claim history,
- query-time recall,
- and deterministic APIs backed by Postgres.

## Documentation map

- Setup and initialization: [docs/SETUP.md](https://github.com/mnexium/core-mnx/blob/main/docs/SETUP.md)
- Runtime behavior and decision logic: [docs/BEHAVIOR.md](https://github.com/mnexium/core-mnx/blob/main/docs/BEHAVIOR.md)
- HTTP endpoints and contracts: [docs/API.md](https://github.com/mnexium/core-mnx/blob/main/docs/API.md)
- Production hardening checklist: [docs/OPERATIONS.md](https://github.com/mnexium/core-mnx/blob/main/docs/OPERATIONS.md)
