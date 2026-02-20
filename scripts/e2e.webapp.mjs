#!/usr/bin/env node
import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getSystemStatus, runCoreRouteSuite } from "./e2e.lib.mjs";

const WEB_PORT = Number(process.env.CORE_E2E_WEB_PORT || 8091);
const WEB_HOST = String(process.env.CORE_E2E_WEB_HOST || "127.0.0.1").trim();

const defaults = {
  baseUrl: process.env.CORE_E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8080}`,
  projectId: process.env.CORE_E2E_PROJECT_ID || process.env.CORE_DEFAULT_PROJECT_ID || "default-project",
  subjectId: process.env.CORE_E2E_SUBJECT_ID || "user_web_e2e",
  db: {
    host: process.env.CORE_E2E_WEB_DB_HOST || "127.0.0.1",
    port: Number(process.env.CORE_E2E_WEB_DB_PORT || 5432),
    database: process.env.CORE_E2E_WEB_DB_NAME || "mnexium_core",
    user: process.env.CORE_E2E_WEB_DB_USER || "mnexium",
    password: process.env.CORE_E2E_WEB_DB_PASSWORD || "mnexium_dev_password",
  },
};

const ROUTE_CATALOG = [
  {
    id: "health",
    name: "Health",
    method: "GET",
    path: "/health",
    description: "Service liveness check.",
    useProjectHeader: false,
    example: { pathParams: {}, query: {}, body: {} },
  },
  {
    id: "events_memories",
    name: "Memories SSE",
    method: "GET",
    path: "/api/v1/events/memories",
    description: "Subscribe to SSE memory events.",
    isSse: true,
    example: { pathParams: {}, query: { subject_id: "user_web_e2e" }, body: {} },
  },
  {
    id: "memories_list",
    name: "List Memories",
    method: "GET",
    path: "/api/v1/memories",
    description: "List memories by subject.",
    example: { pathParams: {}, query: { subject_id: "user_web_e2e", limit: 25, offset: 0 }, body: {} },
  },
  {
    id: "memories_search",
    name: "Search Memories",
    method: "GET",
    path: "/api/v1/memories/search",
    description: "Search memories for a subject.",
    example: { pathParams: {}, query: { subject_id: "user_web_e2e", q: "favorite color", limit: 10 }, body: {} },
  },
  {
    id: "memories_create",
    name: "Create Memory",
    method: "POST",
    path: "/api/v1/memories",
    description: "Create a memory.",
    example: {
      pathParams: {},
      query: {},
      body: {
        subject_id: "user_web_e2e",
        text: "My favorite color is blue",
        kind: "fact",
        extract_claims: true,
        no_supersede: false,
      },
    },
  },
  {
    id: "memories_extract",
    name: "Extract Memories",
    method: "POST",
    path: "/api/v1/memories/extract",
    description: "Extract memories from text.",
    example: {
      pathParams: {},
      query: {},
      body: { subject_id: "user_web_e2e", text: "I work at Acme", learn: true },
    },
  },
  {
    id: "memory_get",
    name: "Get Memory",
    method: "GET",
    path: "/api/v1/memories/:id",
    description: "Get memory by id.",
    example: { pathParams: { id: "__last_memory_id__" }, query: {}, body: {} },
  },
  {
    id: "memory_claims",
    name: "Get Memory Claims",
    method: "GET",
    path: "/api/v1/memories/:id/claims",
    description: "Get claims extracted from a memory.",
    example: { pathParams: { id: "__last_memory_id__" }, query: {}, body: {} },
  },
  {
    id: "memory_patch",
    name: "Update Memory",
    method: "PATCH",
    path: "/api/v1/memories/:id",
    description: "Patch memory fields.",
    example: {
      pathParams: { id: "__last_memory_id__" },
      query: {},
      body: { text: "My favorite color is blue (updated)" },
    },
  },
  {
    id: "memory_delete",
    name: "Delete Memory",
    method: "DELETE",
    path: "/api/v1/memories/:id",
    description: "Soft-delete a memory.",
    example: { pathParams: { id: "__last_memory_id__" }, query: {}, body: {} },
  },
  {
    id: "memories_superseded",
    name: "List Superseded Memories",
    method: "GET",
    path: "/api/v1/memories/superseded",
    description: "List superseded memories for subject.",
    example: { pathParams: {}, query: { subject_id: "user_web_e2e", limit: 25, offset: 0 }, body: {} },
  },
  {
    id: "memory_restore",
    name: "Restore Memory",
    method: "POST",
    path: "/api/v1/memories/:id/restore",
    description: "Restore a superseded memory.",
    example: { pathParams: { id: "__last_memory_id__" }, query: {}, body: {} },
  },
  {
    id: "memories_recalls",
    name: "Memory Recalls",
    method: "GET",
    path: "/api/v1/memories/recalls",
    description: "Get recall events by chat_id or memory_id.",
    example: { pathParams: {}, query: { memory_id: "__last_memory_id__", limit: 25 }, body: {} },
  },
  {
    id: "claim_create",
    name: "Create Claim",
    method: "POST",
    path: "/api/v1/claims",
    description: "Create a claim for subject.",
    example: {
      pathParams: {},
      query: {},
      body: { subject_id: "user_web_e2e", predicate: "favorite_color", object_value: "blue" },
    },
  },
  {
    id: "claim_get",
    name: "Get Claim",
    method: "GET",
    path: "/api/v1/claims/:id",
    description: "Get claim details.",
    example: { pathParams: { id: "__last_claim_id__" }, query: {}, body: {} },
  },
  {
    id: "claim_retract",
    name: "Retract Claim",
    method: "POST",
    path: "/api/v1/claims/:id/retract",
    description: "Retract claim and restore previous slot winner.",
    example: { pathParams: { id: "__last_claim_id__" }, query: {}, body: { reason: "manual_retraction" } },
  },
  {
    id: "claims_truth",
    name: "Subject Truth",
    method: "GET",
    path: "/api/v1/claims/subject/:subjectId/truth",
    description: "Get current truth snapshot.",
    example: { pathParams: { subjectId: "user_web_e2e" }, query: { include_source: true }, body: {} },
  },
  {
    id: "claims_slot",
    name: "Subject Slot",
    method: "GET",
    path: "/api/v1/claims/subject/:subjectId/slot/:slot",
    description: "Get active value for a slot.",
    example: { pathParams: { subjectId: "user_web_e2e", slot: "favorite_color" }, query: {}, body: {} },
  },
  {
    id: "claims_slots",
    name: "Subject Slots",
    method: "GET",
    path: "/api/v1/claims/subject/:subjectId/slots",
    description: "Get grouped slot states.",
    example: { pathParams: { subjectId: "user_web_e2e" }, query: { limit: 100 }, body: {} },
  },
  {
    id: "claims_graph",
    name: "Subject Claim Graph",
    method: "GET",
    path: "/api/v1/claims/subject/:subjectId/graph",
    description: "Get claim graph for subject.",
    example: { pathParams: { subjectId: "user_web_e2e" }, query: { limit: 50 }, body: {} },
  },
  {
    id: "claims_history",
    name: "Subject Claim History",
    method: "GET",
    path: "/api/v1/claims/subject/:subjectId/history",
    description: "Get claim history timeline.",
    example: { pathParams: { subjectId: "user_web_e2e" }, query: { limit: 100 }, body: {} },
  },
];

const DOCS_BASE_URL = "https://www.mnexium.com/docs";
const DOCS_SECTION_ANCHORS = {
  quickstart: `${DOCS_BASE_URL}#quickstart`,
  memories: `${DOCS_BASE_URL}#memories`,
  claims: `${DOCS_BASE_URL}#claims`,
  events: `${DOCS_BASE_URL}#events`,
};

const ROUTE_DOCS_URL_BY_ID = {
  health: DOCS_SECTION_ANCHORS.quickstart,
  events_memories: DOCS_SECTION_ANCHORS.events,

  memories_list: DOCS_SECTION_ANCHORS.memories,
  memories_search: DOCS_SECTION_ANCHORS.memories,
  memories_create: DOCS_SECTION_ANCHORS.memories,
  memories_extract: DOCS_SECTION_ANCHORS.memories,
  memory_get: DOCS_SECTION_ANCHORS.memories,
  memory_claims: DOCS_SECTION_ANCHORS.memories,
  memory_patch: DOCS_SECTION_ANCHORS.memories,
  memory_delete: DOCS_SECTION_ANCHORS.memories,
  memories_superseded: DOCS_SECTION_ANCHORS.memories,
  memory_restore: DOCS_SECTION_ANCHORS.memories,
  memories_recalls: DOCS_SECTION_ANCHORS.memories,

  claim_create: DOCS_SECTION_ANCHORS.claims,
  claim_get: DOCS_SECTION_ANCHORS.claims,
  claim_retract: DOCS_SECTION_ANCHORS.claims,
  claims_truth: DOCS_SECTION_ANCHORS.claims,
  claims_slot: DOCS_SECTION_ANCHORS.claims,
  claims_slots: DOCS_SECTION_ANCHORS.claims,
  claims_graph: DOCS_SECTION_ANCHORS.claims,
  claims_history: DOCS_SECTION_ANCHORS.claims,
};

function docsUrlForRoute(route) {
  const routeId = String(route?.id || "").trim();
  if (routeId && ROUTE_DOCS_URL_BY_ID[routeId]) {
    return ROUTE_DOCS_URL_BY_ID[routeId];
  }
  const path = String(route?.path || "");
  if (path === "/api/v1/events/memories") return DOCS_SECTION_ANCHORS.events;
  if (path.startsWith("/api/v1/memories")) return DOCS_SECTION_ANCHORS.memories;
  if (path.startsWith("/api/v1/claims")) return DOCS_SECTION_ANCHORS.claims;
  return DOCS_BASE_URL;
}

const runs = new Map();
let activeRunId = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientJs = readFileSync(join(__dirname, "e2e.webapp.client.js"), "utf8");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}

function sendJs(res, js) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(js);
}

function toErrorMessage(err) {
  if (!err) return "unknown_error";
  if (typeof err === "string") return err;
  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length > 0) {
    return `AggregateError: ${err.errors.map((e) => toErrorMessage(e)).join(" | ")}`;
  }
  if (err && typeof err === "object" && Array.isArray(err.errors) && err.errors.length > 0) {
    return `AggregateError: ${err.errors.map((e) => toErrorMessage(e)).join(" | ")}`;
  }
  if (err && typeof err === "object" && err.cause) {
    return `${String(err.message || err)} (cause: ${toErrorMessage(err.cause)})`;
  }
  return String(err.message || err);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeConfig(raw = {}) {
  const body = raw || {};
  return {
    baseUrl: String(body.baseUrl || defaults.baseUrl || "").trim().replace(/\/$/, ""),
    projectId: String(body.projectId || defaults.projectId || "default-project").trim(),
    subjectId: String(body.subjectId || defaults.subjectId || "user_web_e2e").trim(),
    db: {
      host: String(body.db?.host || defaults.db.host || "127.0.0.1").trim(),
      port: Number(body.db?.port || defaults.db.port || 5432),
      database: String(body.db?.database || defaults.db.database || "mnexium_core").trim(),
      user: String(body.db?.user || defaults.db.user || "mnexium").trim(),
      password: String(body.db?.password || defaults.db.password || "").trim(),
    },
  };
}

function createPool(db) {
  return new Pool({
    host: db.host,
    port: Number(db.port),
    database: db.database,
    user: db.user,
    password: db.password,
  });
}

function sanitizeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    started_at: run.started_at,
    ended_at: run.ended_at || null,
    config: {
      baseUrl: run.config.baseUrl,
      projectId: run.config.projectId,
      subjectId: run.config.subjectId,
      db: {
        ...run.config.db,
        password: run.config.db.password ? "********" : "",
      },
    },
    logs: run.logs,
    result: run.result || null,
    error: run.error || null,
  };
}

function buildPathWithQuery(pathname, query) {
  const params = new URLSearchParams();
  const source = query && typeof query === "object" ? query : {};
  for (const [key, value] of Object.entries(source)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null || item === "") continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.append(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return pathname;
  return pathname.includes("?") ? `${pathname}&${qs}` : `${pathname}?${qs}`;
}

async function callCore(config, opts) {
  const method = String(opts.method || "GET").toUpperCase();
  const pathname = String(opts.path || "/");
  const useProjectHeader = opts.useProjectHeader !== false;
  const fullPath = buildPathWithQuery(pathname, opts.query);

  const headers = {
    accept: opts.accept || "application/json",
  };
  if (useProjectHeader) {
    headers["x-project-id"] = config.projectId;
  }
  const hasBody = opts.body != null && method !== "GET";
  if (hasBody) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${config.baseUrl}${fullPath}`, {
    method,
    headers,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    path: fullPath,
    data,
  };
}

async function callCoreSseSnapshot(config, opts) {
  const useProjectHeader = opts.useProjectHeader !== false;
  const fullPath = buildPathWithQuery(String(opts.path || "/"), opts.query);
  const timeoutMs = Number(opts.timeoutMs || 4000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    accept: "text/event-stream",
  };
  if (useProjectHeader) {
    headers["x-project-id"] = config.projectId;
  }

  const events = [];
  try {
    const response = await fetch(`${config.baseUrl}${fullPath}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      return {
        ok: false,
        status: response.status,
        path: fullPath,
        data,
        is_sse: true,
      };
    }

    if (!response.body) {
      return {
        ok: false,
        status: response.status,
        path: fullPath,
        data: { error: "empty_sse_body" },
        is_sse: true,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (events.length < 4) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let splitIndex = buffer.indexOf("\n\n");
      while (splitIndex !== -1) {
        const block = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + 2);

        if (block.trim()) {
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = { raw: data };
            }
          }
          events.push({ event, data: parsed });
        }

        if (events.length >= 4) break;
        splitIndex = buffer.indexOf("\n\n");
      }
    }

    return {
      ok: true,
      status: response.status,
      path: fullPath,
      is_sse: true,
      data: {
        event_count: events.length,
        events,
      },
    };
  } catch (err) {
    if (events.length > 0) {
      return {
        ok: true,
        status: 200,
        path: fullPath,
        is_sse: true,
        data: {
          event_count: events.length,
          events,
          note: "stream interrupted after receiving events",
        },
      };
    }
    return {
      ok: false,
      status: 500,
      path: fullPath,
      is_sse: true,
      data: { error: toErrorMessage(err) },
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mnexium CORE Dashboard</title>
  <style>
    :root {
      --bg: #0d1117;
      --panel: #161b22;
      --card: #1f2630;
      --line: #2f3845;
      --text: #e6edf3;
      --muted: #9aa6b2;
      --ok: #238636;
      --bad: #da3633;
      --warn: #d29922;
      --accent: #2f81f7;
      --accent-soft: #1f3252;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(1200px circle at 10% 10%, #1a2330 0%, var(--bg) 50%);
      color: var(--text);
      font-family: ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif;
    }
    .wrap { max-width: 1260px; margin: 24px auto; padding: 0 16px; }
    .title { font-size: 28px; font-weight: 800; margin: 0 0 8px; }
    .sub { color: var(--muted); margin: 0 0 16px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .tab-btn {
      background: var(--accent-soft);
      border: 1px solid var(--line);
      color: var(--text);
      border-radius: 999px;
      padding: 8px 14px;
      cursor: pointer;
      font-weight: 700;
    }
    .tab-btn.active { background: var(--accent); border-color: var(--accent); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .card {
      background: linear-gradient(180deg, var(--panel), #121821);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
    }
    .card h3 { margin: 0 0 10px; font-size: 16px; }
    label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
    input, textarea {
      width: 100%;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      padding: 10px;
      font-size: 14px;
    }
    textarea { min-height: 96px; resize: vertical; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    button {
      background: var(--accent);
      color: white;
      border: 0;
      border-radius: 8px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 700;
    }
    button.secondary { background: #344054; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .statusline {
      margin: 10px 0;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--card);
      border: 1px solid var(--line);
      font-size: 13px;
    }
    .ok { color: #3fb950; }
    .bad { color: #ff7b72; }
    .warn { color: #f2cc60; }
    pre {
      background: #0b1118;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      max-height: 420px;
      overflow: auto;
      font-size: 12px;
      white-space: pre-wrap;
    }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 6px; }
    .full { margin-top: 14px; }
    .routes { display: grid; grid-template-columns: 1fr; gap: 10px; }
    details.route {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #101722;
      padding: 8px;
    }
    details.route > summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      gap: 10px;
      align-items: center;
      font-weight: 700;
    }
    details.route > summary::-webkit-details-marker { display: none; }
    .method {
      display: inline-block;
      min-width: 64px;
      text-align: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 800;
      border: 1px solid var(--line);
      background: #1c2635;
    }
    .route-body { margin-top: 10px; }
    .route-params {
      margin-top: 8px;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--line);
    }
    .route-no-params { margin: 0; }
    .route-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 10px; }
    .route-grid > div { display: flex; flex-direction: column; }
    .route-grid textarea { min-height: 160px; }
    .route-no-inputs {
      grid-column: 1 / -1;
      margin-top: 4px;
    }
    .route-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px dashed var(--line);
    }
    .route-actions button {
      min-width: 132px;
    }
    .route-result { margin-top: 8px; }
    .route-doc-link {
      color: #93c5fd;
      font-size: 12px;
      text-decoration: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      background: #17253b;
      display: inline-block;
    }
    .route-doc-link:hover {
      color: #bfdbfe;
      border-color: #4b5563;
    }
    .route-doc-wrap {
      margin-top: 6px;
      margin-bottom: 8px;
    }
    .tiny { font-size: 12px; color: var(--muted); }
    @media (max-width: 980px) {
      .grid { grid-template-columns: 1fr; }
      .route-actions { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 class="title">Mnexium CORE Dashboard</h1>
    <p class="sub">Connection checks, route-suite runs, and per-route examples.</p>

    <div class="tabs">
      <button class="tab-btn active" data-tab="connection">Connection</button>
      <button class="tab-btn" data-tab="routes">Routes</button>
    </div>

    <section id="tab-connection" class="tab-panel active">
      <div class="grid">
        <section class="card">
          <h3>Target Config</h3>

          <label>Core Base URL</label>
          <input id="baseUrl" />

          <label>Project ID</label>
          <input id="projectId" />

          <label>Subject ID</label>
          <input id="subjectId" />

          <label>Postgres Host</label>
          <input id="dbHost" />

          <label>Postgres Port</label>
          <input id="dbPort" type="number" />

          <label>Postgres DB</label>
          <input id="dbName" />

          <label>Postgres User</label>
          <input id="dbUser" />

          <label>Postgres Password</label>
          <input id="dbPass" type="password" />

          <div class="actions">
            <button id="checkStatusBtn">Check Status</button>
            <button id="runBtn">Run Full Route Suite</button>
            <button class="secondary" id="refreshRunBtn">Refresh Active Run</button>
          </div>
        </section>

        <section class="card">
          <h3>System Status</h3>
          <div id="statusLine" class="statusline">No status checked yet.</div>
          <pre id="statusJson">{}</pre>
        </section>
      </div>

      <section class="card full">
        <h3>Test Run</h3>
        <div id="runLine" class="statusline">No run started.</div>
        <div id="stepsWrap"></div>
        <pre id="runLogs">[]</pre>
      </section>
    </section>

    <section id="tab-routes" class="tab-panel">
      <section class="card">
        <h3>Route Explorer</h3>
        <p class="tiny">Each route has a prefilled example payload. Click <strong>Reset Inputs</strong> to restore defaults, then <strong>Run Route</strong>.</p>
        <div id="routesContainer" class="routes"></div>
      </section>
    </section>
  </div>

  <script src="/app.js"></script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  const method = String(req.method || "GET").toUpperCase();
  const url = new URL(req.url || "/", `http://${WEB_HOST}:${WEB_PORT}`);

  if (method === "GET" && url.pathname === "/") {
    sendHtml(res, pageHtml());
    return;
  }

  if (method === "GET" && url.pathname === "/app.js") {
    sendJs(res, clientJs);
    return;
  }

  if (method === "GET" && url.pathname === "/api/defaults") {
    sendJson(res, 200, { defaults });
    return;
  }

  if (method === "GET" && url.pathname === "/api/routes") {
    sendJson(res, 200, {
      routes: ROUTE_CATALOG.map((route) => ({
        ...route,
        docsUrl: route.docsUrl || docsUrlForRoute(route),
      })),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/status") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid_json_body" });
      return;
    }

    const config = normalizeConfig(body);
    const pool = createPool(config.db);
    try {
      const status = await getSystemStatus({
        baseUrl: config.baseUrl,
        dbPool: pool,
        projectId: config.projectId,
        subjectId: config.subjectId,
      });
      sendJson(res, 200, { status, config: { ...config, db: { ...config.db, password: "********" } } });
    } catch (err) {
      sendJson(res, 500, { error: "status_check_failed", message: toErrorMessage(err) });
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/memories/list") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid_json_body" });
      return;
    }
    const config = normalizeConfig(body.config || body);
    const subjectId = String(body.subjectId || config.subjectId || "").trim();
    if (!subjectId) {
      sendJson(res, 400, { error: "subject_id_required" });
      return;
    }
    const result = await callCore(config, {
      method: "GET",
      path: "/api/v1/memories",
      query: { subject_id: subjectId, limit: 50, offset: 0 },
    });
    sendJson(res, result.status, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/memories/search") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid_json_body" });
      return;
    }
    const config = normalizeConfig(body.config || body);
    const subjectId = String(body.subjectId || config.subjectId || "").trim();
    const q = String(body.q || "").trim();
    if (!subjectId) {
      sendJson(res, 400, { error: "subject_id_required" });
      return;
    }
    if (!q) {
      sendJson(res, 400, { error: "q_required" });
      return;
    }
    const result = await callCore(config, {
      method: "GET",
      path: "/api/v1/memories/search",
      query: { subject_id: subjectId, q, limit: 25 },
    });
    sendJson(res, result.status, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/memories/create") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid_json_body" });
      return;
    }
    const config = normalizeConfig(body.config || body);
    const subjectId = String(body.subjectId || config.subjectId || "").trim();
    const text = String(body.text || "").trim();
    const kind = String(body.kind || "").trim();
    if (!subjectId) {
      sendJson(res, 400, { error: "subject_id_required" });
      return;
    }
    if (!text) {
      sendJson(res, 400, { error: "text_required" });
      return;
    }
    const payload = { subject_id: subjectId, text, ...(kind ? { kind } : {}) };
    const result = await callCore(config, {
      method: "POST",
      path: "/api/v1/memories",
      body: payload,
    });
    sendJson(res, result.status, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/route-exec") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid_json_body" });
      return;
    }

    const config = normalizeConfig(body.config || body);
    const route = body.route || {};
    const routeMethod = String(route.method || "GET").toUpperCase();
    const allowed = new Set(["GET", "POST", "PATCH", "DELETE"]);
    if (!allowed.has(routeMethod)) {
      sendJson(res, 400, { error: "invalid_method" });
      return;
    }

    const routePath = String(route.path || "").trim();
    if (!routePath.startsWith("/")) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }

    try {
      const result = route.isSse
        ? await callCoreSseSnapshot(config, {
            path: routePath,
            query: route.query,
            useProjectHeader: route.useProjectHeader !== false,
            timeoutMs: 4000,
          })
        : await callCore(config, {
            method: routeMethod,
            path: routePath,
            query: route.query,
            body: route.body,
            useProjectHeader: route.useProjectHeader !== false,
          });
      sendJson(res, 200, {
        route_id: route.id || null,
        method: routeMethod,
        path: routePath,
        result,
      });
    } catch (err) {
      sendJson(res, 500, {
        error: "route_exec_failed",
        message: toErrorMessage(err),
      });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/run-tests") {
    if (activeRunId) {
      const active = runs.get(activeRunId);
      if (active && active.status === "running") {
        sendJson(res, 409, { error: "run_in_progress", run_id: activeRunId });
        return;
      }
    }

    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid_json_body" });
      return;
    }

    const config = normalizeConfig(body);
    const runId = `run_${randomUUID()}`;
    const run = {
      id: runId,
      status: "running",
      started_at: new Date().toISOString(),
      ended_at: null,
      config,
      logs: [],
      result: null,
      error: null,
    };

    runs.set(runId, run);
    activeRunId = runId;

    void (async () => {
      const pool = createPool(config.db);
      try {
        const result = await runCoreRouteSuite({
          baseUrl: config.baseUrl,
          projectId: config.projectId,
          subjectId: config.subjectId,
          dbPool: pool,
          onLog: (line) => {
            run.logs.push(line);
            if (run.logs.length > 1000) run.logs.shift();
          },
        });
        run.result = result;
        run.status = result.ok ? "passed" : "failed";
        run.error = result.ok ? null : result.error || "suite_failed";
      } catch (err) {
        run.status = "failed";
        run.error = toErrorMessage(err);
      } finally {
        run.ended_at = new Date().toISOString();
        await pool.end().catch(() => undefined);
      }
    })();

    sendJson(res, 202, { run_id: runId, status: "running" });
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/run-tests\/([^/]+)$/);
  if (method === "GET" && runMatch) {
    const id = decodeURIComponent(runMatch[1]);
    const run = runs.get(id);
    if (!run) {
      sendJson(res, 404, { error: "run_not_found" });
      return;
    }
    sendJson(res, 200, { run: sanitizeRun(run) });
    return;
  }

  sendJson(res, 404, { error: "not_found", path: url.pathname, method });
});

server.listen(WEB_PORT, WEB_HOST, () => {
  console.log(`[core:e2e:web] listening on http://${WEB_HOST}:${WEB_PORT}`);
});
