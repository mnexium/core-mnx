import process from "node:process";
import { Pool } from "pg";
import { runCoreRouteSuite } from "./e2e.lib.mjs";

const baseUrl = process.env.CORE_E2E_BASE_URL || "http://127.0.0.1:18080";
const projectId = process.env.CORE_E2E_PROJECT_ID || "default-project";
const subjectId = process.env.CORE_E2E_SUBJECT_ID || "user_e2e";

const dbPool = new Pool({
  host: process.env.POSTGRES_HOST || "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER || "mnexium",
  password: process.env.POSTGRES_PASSWORD || "mnexium_dev_password",
  database: process.env.POSTGRES_DB || "mnexium_core",
});

const result = await runCoreRouteSuite({
  baseUrl,
  projectId,
  subjectId,
  dbPool,
  onLog: (line) => console.log(`[e2e] ${line}`),
});

if (result.ok) {
  console.log("[e2e] all routes passed");
} else {
  console.error("[e2e] FAILED", result.error || "unknown error");
  process.exitCode = 1;
}

await dbPool.end().catch(() => undefined);
