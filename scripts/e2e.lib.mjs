import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function defaultHeaders(projectId, extra = {}) {
  return {
    "content-type": "application/json",
    "x-project-id": projectId,
    ...extra,
  };
}

function createRequest(baseUrl, projectId) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!normalizedBaseUrl) throw new Error("baseUrl is required");

  return async function request(method, path, opts = {}) {
    const response = await fetch(`${normalizedBaseUrl}${path}`, {
      method,
      headers: opts.headers || defaultHeaders(projectId),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }

    if (opts.expectedStatus && response.status !== opts.expectedStatus) {
      throw new Error(
        `${method} ${path} expected ${opts.expectedStatus}, got ${response.status}: ${JSON.stringify(json)}`,
      );
    }

    return { status: response.status, json };
  };
}

async function waitForHealth(baseUrl, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
      if (res.ok) return true;
    } catch {
      // Continue retry loop.
    }
    await delay(500);
  }
  throw new Error(`Server at ${baseUrl} did not become healthy in time`);
}

async function openSSEAndCaptureMemoryCreated({
  baseUrl,
  projectId,
  subjectId,
  onConnected,
  timeoutMs = 12_000,
}) {
  const controller = new AbortController();
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/events/memories?subject_id=${encodeURIComponent(subjectId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-project-id": projectId,
      accept: "text/event-stream",
    },
    signal: controller.signal,
  });

  assert(response.ok, `SSE subscribe failed: ${response.status}`);
  assert(response.body, "SSE response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let connectedSeen = false;
  let resolved = false;

  const parseEventBlock = (block) => {
    const lines = block.split("\n");
    let event = "message";
    let data = "";
    for (const line of lines) {
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
    return { event, data: parsed };
  };

  const timeout = setTimeout(() => {
    if (!resolved) controller.abort(new Error("Timed out waiting for SSE memory.created"));
  }, timeoutMs);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        const evt = parseEventBlock(block);
        if (evt.event === "connected" && !connectedSeen) {
          connectedSeen = true;
          if (typeof onConnected === "function") {
            await onConnected();
          }
        }
        if (evt.event === "memory.created") {
          resolved = true;
          assert(connectedSeen, "SSE memory.created arrived before connected event");
          return evt.data;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  throw new Error("SSE ended before memory.created event was observed");
}

async function seedSuperseded({ dbPool, projectId, subjectId, memoryId }) {
  await dbPool.query(
    `
      UPDATE memories
      SET status = 'superseded', superseded_by = $4
      WHERE project_id = $1 AND subject_id = $2 AND id = $3
    `,
    [projectId, subjectId, memoryId, `mem_sup_${randomUUID()}`],
  );
}

async function seedRecallEvent({ dbPool, projectId, subjectId, memoryId, chatId, score = 77 }) {
  await dbPool.query(
    `
      INSERT INTO memory_recall_events (
        event_id, project_id, subject_id, memory_id, memory_text,
        chat_id, message_index, chat_logged, similarity_score,
        request_type, model, metadata
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, TRUE, $8,
        'chat', 'e2e-test-model', '{}'::jsonb
      )
    `,
    [`evt_${randomUUID()}`, projectId, subjectId, memoryId, "test recall", chatId, 1, score],
  );
}

export async function runCoreRouteSuite({
  baseUrl,
  projectId,
  subjectId,
  dbPool,
  onLog,
}) {
  const logs = [];
  const steps = [];
  const artifacts = {};
  const startedAt = Date.now();

  const log = (message) => {
    const entry = `[${new Date().toISOString()}] ${message}`;
    logs.push(entry);
    if (typeof onLog === "function") onLog(entry);
  };

  const request = createRequest(baseUrl, projectId);

  async function step(name, fn) {
    const stepStart = Date.now();
    log(`STEP START: ${name}`);
    try {
      const value = await fn();
      const finished = {
        name,
        status: "passed",
        duration_ms: Date.now() - stepStart,
      };
      steps.push(finished);
      log(`STEP PASS: ${name} (${finished.duration_ms}ms)`);
      return value;
    } catch (err) {
      const failed = {
        name,
        status: "failed",
        duration_ms: Date.now() - stepStart,
        error: toErrorMessage(err),
      };
      steps.push(failed);
      log(`STEP FAIL: ${name} (${failed.duration_ms}ms) - ${failed.error}`);
      throw err;
    }
  }

  try {
    await step("wait_for_health", async () => {
      await waitForHealth(baseUrl);
    });

    await step("health_endpoint", async () => {
      const res = await request("GET", "/health", {
        expectedStatus: 200,
        headers: { accept: "application/json" },
      });
      assert(res.json?.ok === true, "health response missing ok=true");
    });

    const memoryText = "My favorite color is yellow and I live in Austin";
    let currentMemoryText = memoryText;
    let memoryId = "";

    await step("sse_and_create_memory", async () => {
      const createdViaSSE = await openSSEAndCaptureMemoryCreated({
        baseUrl,
        projectId,
        subjectId,
        onConnected: async () => {
          const createRes = await request("POST", "/api/v1/memories", {
            expectedStatus: 201,
            body: { subject_id: subjectId, text: memoryText, kind: "fact" },
          });
          assert(String(createRes.json?.id || "").startsWith("mem_"), "create memory did not return memory id");
        },
      });
      memoryId = String(createdViaSSE?.id || "");
      assert(memoryId.startsWith("mem_"), "SSE memory.created did not include memory id");
      artifacts.memory_id = memoryId;
    });

    await step("list_memories", async () => {
      const res = await request(
        "GET",
        `/api/v1/memories?subject_id=${encodeURIComponent(subjectId)}&limit=10&offset=0`,
        { expectedStatus: 200 },
      );
      assert(Array.isArray(res.json?.data), "list memories data is not an array");
      assert(res.json.data.some((m) => m.id === memoryId), "created memory missing from list");
    });

    await step("get_memory_by_id", async () => {
      const res = await request("GET", `/api/v1/memories/${encodeURIComponent(memoryId)}`, { expectedStatus: 200 });
      assert(res.json?.data?.id === memoryId, "get memory by id mismatch");
    });

    await step("patch_memory", async () => {
      const updatedText = "My favorite color is yellow (updated)";
      const patch = await request("PATCH", `/api/v1/memories/${encodeURIComponent(memoryId)}`, {
        expectedStatus: 200,
        body: { text: updatedText, tags: ["e2e", "updated"] },
      });
      assert(patch.json?.updated === true, "patch memory failed");
      const check = await request("GET", `/api/v1/memories/${encodeURIComponent(memoryId)}`, { expectedStatus: 200 });
      assert(check.json?.data?.text === updatedText, "memory text was not updated");
      currentMemoryText = updatedText;
    });

    await step("search_memories", async () => {
      const res = await request(
        "GET",
        `/api/v1/memories/search?subject_id=${encodeURIComponent(subjectId)}&q=${encodeURIComponent("favorite color")}&limit=10`,
        { expectedStatus: 200 },
      );
      assert(Array.isArray(res.json?.data), "search memories data is not an array");
    });

    await step("create_memory_duplicate_skip", async () => {
      const duplicate = await request("POST", "/api/v1/memories", {
        expectedStatus: 200,
        body: { subject_id: subjectId, text: currentMemoryText, kind: "fact" },
      });
      assert(duplicate.json?.created === false, "duplicate memory should not be created");
      assert(duplicate.json?.reason === "duplicate", "duplicate response reason mismatch");
    });

    let extractedMemoryId = "";

    await step("extract_memories_non_learn", async () => {
      const res = await request("POST", "/api/v1/memories/extract", {
        expectedStatus: 200,
        body: { subject_id: subjectId, text: "I work at Acme", learn: false },
      });
      assert(res.json?.learned === false, "extract learn=false response mismatch");
      assert(Array.isArray(res.json?.memories), "extract memories should be array");
    });

    await step("extract_memories_learn", async () => {
      const res = await request("POST", "/api/v1/memories/extract", {
        expectedStatus: 200,
        body: { subject_id: subjectId, text: "My name is Marius", learn: true, force: true },
      });
      assert(res.json?.learned === true, "extract learn=true response mismatch");
      assert(Array.isArray(res.json?.memories), "extract learn=true memories should be array");
      if (res.json.memories.length > 0) {
        extractedMemoryId = String(res.json.memories[0].memory_id || "");
        artifacts.extracted_memory_id = extractedMemoryId;
      }
    });

    let claimA = "";
    let claimB = "";

    await step("create_claims_and_memory_claims", async () => {
      const c1 = await request("POST", "/api/v1/claims", {
        expectedStatus: 201,
        body: {
          subject_id: subjectId,
          predicate: "favorite_color",
          object_value: "yellow",
          source_memory_id: memoryId,
        },
      });
      claimA = String(c1.json?.claim_id || "");
      assert(claimA.startsWith("clm_"), "first claim id invalid");

      const memoryClaims = await request("GET", `/api/v1/memories/${encodeURIComponent(memoryId)}/claims`, {
        expectedStatus: 200,
      });
      assert(Array.isArray(memoryClaims.json?.data), "memory claims data should be array");

      const c2 = await request("POST", "/api/v1/claims", {
        expectedStatus: 201,
        body: {
          subject_id: subjectId,
          predicate: "favorite_color",
          object_value: "blue",
        },
      });
      claimB = String(c2.json?.claim_id || "");
      assert(claimB.startsWith("clm_"), "second claim id invalid");

      artifacts.claim_a = claimA;
      artifacts.claim_b = claimB;
    });

    await step("get_claim_by_id", async () => {
      const res = await request("GET", `/api/v1/claims/${encodeURIComponent(claimB)}`, { expectedStatus: 200 });
      assert(res.json?.claim?.claim_id === claimB, "get claim mismatch");
      assert(Array.isArray(res.json?.assertions), "claim assertions should be array");
    });

    await step("claims_subject_endpoints", async () => {
      const truth = await request("GET", `/api/v1/claims/subject/${encodeURIComponent(subjectId)}/truth`, {
        expectedStatus: 200,
      });
      assert(Array.isArray(truth.json?.slots), "truth slots should be array");

      const slot = await request(
        "GET",
        `/api/v1/claims/subject/${encodeURIComponent(subjectId)}/slot/${encodeURIComponent("favorite_color")}`,
        { expectedStatus: 200 },
      );
      assert(slot.json?.slot === "favorite_color", "slot endpoint returned wrong slot");

      const slots = await request("GET", `/api/v1/claims/subject/${encodeURIComponent(subjectId)}/slots?limit=20`, {
        expectedStatus: 200,
      });
      assert(slots.json?.slots && typeof slots.json.slots === "object", "slots group response missing");

      const graph = await request("GET", `/api/v1/claims/subject/${encodeURIComponent(subjectId)}/graph?limit=20`, {
        expectedStatus: 200,
      });
      assert(Array.isArray(graph.json?.claims), "graph claims should be array");

      const history = await request("GET", `/api/v1/claims/subject/${encodeURIComponent(subjectId)}/history?limit=20`, {
        expectedStatus: 200,
      });
      assert(history.json && typeof history.json.by_slot === "object", "history by_slot missing");
    });

    await step("retract_claim", async () => {
      const retract = await request("POST", `/api/v1/claims/${encodeURIComponent(claimB)}/retract`, {
        expectedStatus: 200,
        body: { reason: "e2e_retract" },
      });
      assert(retract.json?.success === true, "retract claim failed");
      assert(retract.json?.restored_previous === true, "expected previous claim to be restored");
    });

    await step("superseded_and_restore_memory", async () => {
      await seedSuperseded({ dbPool, projectId, subjectId, memoryId });

      const superseded = await request(
        "GET",
        `/api/v1/memories/superseded?subject_id=${encodeURIComponent(subjectId)}&limit=10&offset=0`,
        { expectedStatus: 200 },
      );
      assert(Array.isArray(superseded.json?.data), "superseded data should be array");
      assert(superseded.json.data.some((m) => m.id === memoryId), "superseded list missing memory");

      const restore = await request("POST", `/api/v1/memories/${encodeURIComponent(memoryId)}/restore`, {
        expectedStatus: 200,
        body: {},
      });
      assert(restore.json?.restored === true, "restore memory failed");

      const alreadyActive = await request("POST", `/api/v1/memories/${encodeURIComponent(memoryId)}/restore`, {
        expectedStatus: 200,
        body: {},
      });
      assert(alreadyActive.json?.restored === false, "restore on active memory should return restored=false");
    });

    await step("memory_recalls_variants", async () => {
      const recallMemoryId = extractedMemoryId || memoryId;
      const chatId = `chat_${randomUUID()}`;
      await seedRecallEvent({ dbPool, projectId, subjectId, memoryId: recallMemoryId, chatId, score: 88 });

      const byChat = await request(
        "GET",
        `/api/v1/memories/recalls?chat_id=${encodeURIComponent(chatId)}`,
        { expectedStatus: 200 },
      );
      assert(Array.isArray(byChat.json?.data), "recalls by chat should return array");
      assert(byChat.json.data.length >= 1, "recalls by chat should have seeded event");

      const byMemory = await request(
        "GET",
        `/api/v1/memories/recalls?memory_id=${encodeURIComponent(recallMemoryId)}&limit=10`,
        { expectedStatus: 200 },
      );
      assert(Array.isArray(byMemory.json?.data), "recalls by memory should return array");

      const stats = await request(
        "GET",
        `/api/v1/memories/recalls?memory_id=${encodeURIComponent(recallMemoryId)}&stats=true`,
        { expectedStatus: 200 },
      );
      assert(Number(stats.json?.stats?.total_recalls || 0) >= 1, "recall stats should be >= 1");
    });

    await step("delete_memory", async () => {
      const del = await request("DELETE", `/api/v1/memories/${encodeURIComponent(memoryId)}`, {
        expectedStatus: 200,
      });
      assert(del.json?.deleted === true, "delete memory failed");

      const afterDelete = await request("GET", `/api/v1/memories/${encodeURIComponent(memoryId)}`, {
        expectedStatus: 404,
      });
      assert(afterDelete.json?.error === "memory_deleted", "deleted memory should return memory_deleted");
    });

    const result = {
      ok: true,
      duration_ms: Date.now() - startedAt,
      steps,
      artifacts,
      logs,
    };
    log(`SUITE PASS in ${result.duration_ms}ms`);
    return result;
  } catch (err) {
    const result = {
      ok: false,
      duration_ms: Date.now() - startedAt,
      steps,
      artifacts,
      logs,
      error: toErrorMessage(err),
    };
    log(`SUITE FAIL in ${result.duration_ms}ms: ${result.error}`);
    return result;
  }
}

export async function getSystemStatus({ baseUrl, dbPool, projectId, subjectId }) {
  const effectiveProjectId = String(projectId || "default-project").trim() || "default-project";
  const effectiveSubjectId = String(subjectId || "status_probe_subject").trim() || "status_probe_subject";
  const status = {
    timestamp: new Date().toISOString(),
    core: {
      reachable: false,
      status_code: null,
      ok: false,
      payload: null,
      error: null,
      db_route_probe: {
        ok: false,
        status_code: null,
        error: null,
      },
    },
    postgres: {
      connected: false,
      error: null,
      version: null,
      expected_tables: {},
      all_public_tables: [],
    },
  };

  try {
    const healthRes = await fetch(`${String(baseUrl || "").replace(/\/$/, "")}/health`);
    status.core.reachable = true;
    status.core.status_code = healthRes.status;
    const text = await healthRes.text();
    try {
      status.core.payload = text ? JSON.parse(text) : null;
    } catch {
      status.core.payload = { raw: text };
    }
    status.core.ok = healthRes.ok && status.core.payload?.ok === true;

    try {
      const probeRes = await fetch(
        `${String(baseUrl || "").replace(/\/$/, "")}/api/v1/memories?subject_id=${encodeURIComponent(effectiveSubjectId)}&limit=1`,
        {
          method: "GET",
          headers: {
            "x-project-id": effectiveProjectId,
            accept: "application/json",
          },
        },
      );
      status.core.db_route_probe.status_code = probeRes.status;
      const probeText = await probeRes.text();
      let probeJson = null;
      try {
        probeJson = probeText ? JSON.parse(probeText) : null;
      } catch {
        probeJson = { raw: probeText };
      }
      status.core.db_route_probe.ok = probeRes.ok;
      if (!probeRes.ok) {
        status.core.db_route_probe.error = probeJson?.message || probeJson?.error || `HTTP ${probeRes.status}`;
      }
    } catch (err) {
      status.core.db_route_probe.error = toErrorMessage(err);
    }
  } catch (err) {
    status.core.error = toErrorMessage(err);
  }

  try {
    const versionRes = await dbPool.query("select version() as version, now() as now");
    status.postgres.connected = true;
    status.postgres.version = versionRes.rows?.[0]?.version || null;

    const expected = [
      "memories",
      "claims",
      "claim_assertions",
      "claim_edges",
      "slot_state",
      "memory_recall_events",
    ];

    const tableRes = await dbPool.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name ASC
      `,
    );
    const names = tableRes.rows.map((r) => r.table_name);
    status.postgres.all_public_tables = names;
    for (const table of expected) {
      status.postgres.expected_tables[table] = names.includes(table);
    }
  } catch (err) {
    status.postgres.error = toErrorMessage(err);
  }

  return status;
}
