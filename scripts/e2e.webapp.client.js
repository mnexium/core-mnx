(() => {
  const state = {
    activeRunId: null,
    pollTimer: null,
    routes: [],
    lastMemoryId: "",
    lastClaimId: "",
  };

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function api(path, method = "GET", body) {
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || payload.message || ("HTTP " + res.status));
    }
    return payload;
  }

  function cfg() {
    return {
      baseUrl: document.getElementById("baseUrl").value.trim(),
      projectId: document.getElementById("projectId").value.trim(),
      subjectId: document.getElementById("subjectId").value.trim(),
      db: {
        host: document.getElementById("dbHost").value.trim(),
        port: Number(document.getElementById("dbPort").value),
        database: document.getElementById("dbName").value.trim(),
        user: document.getElementById("dbUser").value.trim(),
        password: document.getElementById("dbPass").value,
      },
    };
  }

  function setStatusLine(message, tone = "warn") {
    const el = document.getElementById("statusLine");
    el.innerHTML = '<span class="' + tone + '">' + esc(message) + '</span>';
  }

  function setRunLine(message, tone = "warn") {
    const el = document.getElementById("runLine");
    el.innerHTML = '<span class="' + tone + '">' + esc(message) + '</span>';
  }

  function setActiveTab(tabName) {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === ("tab-" + tabName));
    });
  }

  function renderSteps(result) {
    const wrap = document.getElementById("stepsWrap");
    if (!result || !Array.isArray(result.steps) || result.steps.length === 0) {
      wrap.innerHTML = "";
      return;
    }
    const rows = result.steps
      .map((s) => {
        const tone = s.status === "passed" ? "ok" : "bad";
        const err = s.error ? esc(String(s.error)) : "";
        return (
          "<tr>" +
          "<td>" + esc(s.name) + "</td>" +
          '<td class="' + tone + '">' + esc(s.status) + "</td>" +
          "<td>" + Number(s.duration_ms || 0) + "ms</td>" +
          "<td>" + err + "</td>" +
          "</tr>"
        );
      })
      .join("");

    wrap.innerHTML =
      "<table><thead><tr><th>Step</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead><tbody>" +
      rows +
      "</tbody></table>";
  }

  function parseJsonField(value, label) {
    const raw = String(value || "").trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(label + " must be valid JSON");
    }
  }

  function routePathParamNames(path) {
    const matches = Array.from(String(path || "").matchAll(/:([A-Za-z0-9_]+)/g));
    return matches.map((m) => m[1]);
  }

  function resolveExampleValue(rawValue) {
    if (rawValue === "__last_memory_id__") {
      return state.lastMemoryId || "mem_xxx";
    }
    if (rawValue === "__last_claim_id__") {
      return state.lastClaimId || "clm_xxx";
    }
    return rawValue;
  }

  function normalizeExample(route) {
    const ex = route.example || {};
    const pathParams = {};
    const query = {};
    const body = {};

    Object.entries(ex.pathParams || {}).forEach(([k, v]) => {
      pathParams[k] = resolveExampleValue(v);
    });
    Object.entries(ex.query || {}).forEach(([k, v]) => {
      query[k] = resolveExampleValue(v);
    });
    Object.entries(ex.body || {}).forEach(([k, v]) => {
      body[k] = resolveExampleValue(v);
    });

    return { pathParams, query, body };
  }

  function routeCardHtml(route) {
    const params = routePathParamNames(route.path);
    const method = esc(route.method);
    const path = esc(route.path);
    const docsUrl = esc(route.docsUrl || "https://www.mnexium.com/docs");
    const ex = route.example || {};
    const hasQueryInput = !!(ex.query && typeof ex.query === "object" && Object.keys(ex.query).length > 0);
    const hasBodyInput = !!(ex.body && typeof ex.body === "object" && Object.keys(ex.body).length > 0);

    const paramFields =
      params.length === 0
        ? '<div class="tiny route-no-params">No path params.</div>'
        : params
            .map(
              (p) =>
                '<label>Path param: ' +
                esc(p) +
                '</label><input id="route-' +
                esc(route.id) +
                '-param-' +
                esc(p) +
                '" placeholder="' +
                esc(p) +
                '" />',
            )
            .join("");

    const queryColumn = hasQueryInput
      ? '<div><label>Query JSON</label><textarea id="route-' + esc(route.id) + '-query">{}</textarea></div>'
      : "";
    const bodyColumn = hasBodyInput
      ? '<div><label>Body JSON</label><textarea id="route-' + esc(route.id) + '-body">{}</textarea></div>'
      : "";
    const noInputs = !hasQueryInput && !hasBodyInput
      ? '<div class="tiny route-no-inputs">No query/body input needed for this route.</div>'
      : "";

    return (
      '<details class="route">' +
      '<summary><span class="method">' +
      method +
      "</span><span>" +
      path +
      "</span><span class=\"tiny\">" +
      esc(route.name) +
      "</span></summary>" +
      '<div class="route-body">' +
      '<div class="tiny">' +
      esc(route.description || "") +
      "</div>" +
      '<div class="route-doc-wrap"><a class="route-doc-link" href="' +
      docsUrl +
      '" target="_blank" rel="noreferrer">Open Docs</a></div>' +
      '<div class="route-params">' +
      paramFields +
      "</div>" +
      '<div class="route-grid">' +
      queryColumn +
      bodyColumn +
      noInputs +
      "</div>" +
      '<div class="route-actions">' +
      '<button class="secondary" id="route-' +
      esc(route.id) +
      '-example">Reset Inputs</button>' +
      '<button id="route-' +
      esc(route.id) +
      '-run">Run Route</button>' +
      "</div>" +
      '<div class="route-result">' +
      '<pre id="route-' +
      esc(route.id) +
      '-result">{}</pre>' +
      "</div>" +
      "</div>" +
      "</details>"
    );
  }

  function applyRouteExample(route) {
    const ex = normalizeExample(route);
    const params = routePathParamNames(route.path);
    for (const p of params) {
      const input = document.getElementById("route-" + route.id + "-param-" + p);
      if (input) {
        const value = ex.pathParams[p];
        input.value = value == null ? "" : String(value);
      }
    }

    const queryEl = document.getElementById("route-" + route.id + "-query");
    const bodyEl = document.getElementById("route-" + route.id + "-body");
    if (queryEl) queryEl.value = JSON.stringify(ex.query || {}, null, 2);
    if (bodyEl) bodyEl.value = JSON.stringify(ex.body || {}, null, 2);
  }

  function extractRoutePath(route) {
    const params = routePathParamNames(route.path);
    let path = route.path;
    for (const p of params) {
      const input = document.getElementById("route-" + route.id + "-param-" + p);
      const value = String(input?.value || "").trim();
      if (!value) throw new Error("Missing path param: " + p);
      path = path.replace(":" + p, encodeURIComponent(value));
    }
    return path;
  }

  function syncHintsFromResponse(payload) {
    const data = payload?.result?.data;
    if (!data || typeof data !== "object") return;

    const memoryId = String(data.id || data.memory_id || "").trim();
    if (memoryId.startsWith("mem_")) state.lastMemoryId = memoryId;

    const claimId = String(data.claim_id || data?.claim?.claim_id || "").trim();
    if (claimId.startsWith("clm_")) state.lastClaimId = claimId;
  }

  async function runRoute(route) {
    const resultEl = document.getElementById("route-" + route.id + "-result");
    try {
      const queryEl = document.getElementById("route-" + route.id + "-query");
      const bodyEl = document.getElementById("route-" + route.id + "-body");
      const query = queryEl
        ? parseJsonField(queryEl.value, route.method + " " + route.path + " query")
        : {};
      const body = bodyEl
        ? parseJsonField(bodyEl.value, route.method + " " + route.path + " body")
        : {};
      const path = extractRoutePath(route);

      const payload = await api("/api/route-exec", "POST", {
        config: cfg(),
        route: {
          id: route.id,
          method: route.method,
          path,
          query,
          body: route.method === "GET" || route.method === "DELETE" ? undefined : body,
          isSse: route.isSse === true,
          useProjectHeader: route.useProjectHeader !== false,
        },
      });

      syncHintsFromResponse(payload);
      resultEl.textContent = JSON.stringify(payload, null, 2);
    } catch (err) {
      resultEl.textContent = JSON.stringify({ error: String(err.message || err) }, null, 2);
    }
  }

  function renderRoutes(routes) {
    const container = document.getElementById("routesContainer");
    container.innerHTML = routes.map(routeCardHtml).join("");

    routes.forEach((route) => {
      const exampleBtn = document.getElementById("route-" + route.id + "-example");
      const runBtn = document.getElementById("route-" + route.id + "-run");
      if (exampleBtn) exampleBtn.addEventListener("click", () => applyRouteExample(route));
      if (runBtn) runBtn.addEventListener("click", () => runRoute(route));
      applyRouteExample(route);
    });
  }

  async function loadDefaultsAndRoutes() {
    const defaultsData = await api("/api/defaults");
    document.getElementById("baseUrl").value = defaultsData.defaults.baseUrl;
    document.getElementById("projectId").value = defaultsData.defaults.projectId;
    document.getElementById("subjectId").value = defaultsData.defaults.subjectId;
    document.getElementById("dbHost").value = defaultsData.defaults.db.host;
    document.getElementById("dbPort").value = defaultsData.defaults.db.port;
    document.getElementById("dbName").value = defaultsData.defaults.db.database;
    document.getElementById("dbUser").value = defaultsData.defaults.db.user;
    document.getElementById("dbPass").value = defaultsData.defaults.db.password;
    const routeData = await api("/api/routes");
    state.routes = Array.isArray(routeData.routes) ? routeData.routes : [];
    renderRoutes(state.routes);
  }

  async function checkStatus() {
    try {
      setStatusLine("Checking CORE and Postgres...", "warn");
      const data = await api("/api/status", "POST", cfg());
      document.getElementById("statusJson").textContent = JSON.stringify(data, null, 2);
      const coreOk = data.status?.core?.ok;
      const pgOk = data.status?.postgres?.connected;
      const coreDbProbeOk = data.status?.core?.db_route_probe?.ok;
      if (coreOk && pgOk && coreDbProbeOk) {
        setStatusLine("CORE reachable, CORE DB route ok, and Postgres connected", "ok");
      } else if (coreOk && pgOk && !coreDbProbeOk) {
        setStatusLine("CORE health is up, but CORE DB route probe failed (likely CORE env DB mismatch)", "bad");
      } else if (!coreOk && !pgOk) {
        setStatusLine("CORE and Postgres are both failing checks", "bad");
      } else if (!coreOk) {
        setStatusLine("Postgres ok, CORE health check failing", "warn");
      } else {
        setStatusLine("CORE ok, Postgres check failing", "warn");
      }
    } catch (err) {
      setStatusLine("Status check failed: " + String(err.message || err), "bad");
    }
  }

  async function fetchRun(id) {
    const data = await api("/api/run-tests/" + encodeURIComponent(id));
    const run = data.run;
    document.getElementById("runLogs").textContent = JSON.stringify(run.logs || [], null, 2);
    renderSteps(run.result);

    if (run.status === "running") {
      setRunLine("Run " + run.id + " is running...", "warn");
      return false;
    }

    if (run.status === "passed") {
      setRunLine("Run " + run.id + " passed in " + run.result.duration_ms + "ms", "ok");
    } else {
      const msg = run.error || run.result?.error || "unknown error";
      setRunLine("Run " + run.id + " failed: " + msg, "bad");
    }
    return true;
  }

  function startPolling(id) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.activeRunId = id;
    state.pollTimer = setInterval(async () => {
      try {
        const done = await fetchRun(id);
        if (done) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      } catch (err) {
        setRunLine("Polling failed: " + String(err.message || err), "bad");
      }
    }, 1200);
  }

  async function runTests() {
    const runBtn = document.getElementById("runBtn");
    runBtn.disabled = true;
    try {
      setRunLine("Starting run...", "warn");
      const data = await api("/api/run-tests", "POST", cfg());
      startPolling(data.run_id);
      await fetchRun(data.run_id);
    } catch (err) {
      setRunLine("Start failed: " + String(err.message || err), "bad");
    } finally {
      runBtn.disabled = false;
    }
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });

  document.getElementById("checkStatusBtn").addEventListener("click", checkStatus);
  document.getElementById("runBtn").addEventListener("click", runTests);
  document.getElementById("refreshRunBtn").addEventListener("click", async () => {
    if (!state.activeRunId) {
      setRunLine("No active run id yet.", "warn");
      return;
    }
    await fetchRun(state.activeRunId);
  });
  loadDefaultsAndRoutes().catch((err) => {
    setStatusLine("Failed to load dashboard data: " + String(err.message || err), "bad");
  });
})();
