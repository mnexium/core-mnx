#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DB_CONTAINER_NAME="${CORE_E2E_DB_CONTAINER:-mnx-core-e2e-db}"
DB_IMAGE="${CORE_E2E_DB_IMAGE:-pgvector/pgvector:pg16}"
DB_PORT="${CORE_E2E_DB_PORT:-5432}"
DB_NAME="${CORE_E2E_DB_NAME:-mnexium_core}"
DB_USER="${CORE_E2E_DB_USER:-mnexium}"
DB_PASSWORD="${CORE_E2E_DB_PASSWORD:-mnexium_dev_password}"
SERVER_PORT="${CORE_E2E_SERVER_PORT:-18080}"
PROJECT_ID="${CORE_E2E_PROJECT_ID:-default-project}"
KEEP_DB="${CORE_E2E_KEEP_DB:-false}"

SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi

  if [[ "${KEEP_DB}" != "true" ]]; then
    docker rm -f "${DB_CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[e2e] starting docker postgres container ${DB_CONTAINER_NAME} on ${DB_PORT}"
docker rm -f "${DB_CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run -d \
  --name "${DB_CONTAINER_NAME}" \
  -e POSTGRES_DB="${DB_NAME}" \
  -e POSTGRES_USER="${DB_USER}" \
  -e POSTGRES_PASSWORD="${DB_PASSWORD}" \
  -p "${DB_PORT}:5432" \
  "${DB_IMAGE}" >/dev/null

echo "[e2e] waiting for postgres readiness"
for _ in $(seq 1 60); do
  if docker exec "${DB_CONTAINER_NAME}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker exec "${DB_CONTAINER_NAME}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
  echo "[e2e] postgres did not become ready"
  exit 1
fi

echo "[e2e] applying schema"
cat "${ROOT_DIR}/sql/postgres/schema.sql" | docker exec -i "${DB_CONTAINER_NAME}" psql -U "${DB_USER}" -d "${DB_NAME}" >/dev/null

echo "[e2e] starting CORE server on :${SERVER_PORT}"
export POSTGRES_HOST="127.0.0.1"
export POSTGRES_PORT="${DB_PORT}"
export POSTGRES_DB="${DB_NAME}"
export POSTGRES_USER="${DB_USER}"
export POSTGRES_PASSWORD="${DB_PASSWORD}"
export CORE_DEFAULT_PROJECT_ID="${PROJECT_ID}"
export PORT="${SERVER_PORT}"
export CORE_AI_MODE="simple"
export USE_RETRIEVAL_EXPAND="false"
export CORE_DEBUG="false"

npm --prefix "${ROOT_DIR}" run dev >/tmp/mnx-core-e2e-server.log 2>&1 &
SERVER_PID=$!

echo "[e2e] running route tests"
export CORE_E2E_BASE_URL="http://127.0.0.1:${SERVER_PORT}"
export CORE_E2E_PROJECT_ID="${PROJECT_ID}"
node "${ROOT_DIR}/scripts/e2e.routes.mjs"

echo "[e2e] success"
