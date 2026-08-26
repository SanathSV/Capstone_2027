#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$ROOT_DIR/server-python"
CLIENT_DIR="$ROOT_DIR/client-rust"
VENV_DIR="$ROOT_DIR/.venv"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "[ERROR] Missing virtual environment at $VENV_DIR"
  echo "Create it first with: python3.12 -m venv .venv"
  exit 1
fi

source "$VENV_DIR/bin/activate"

if ! command -v curl >/dev/null 2>&1; then
  echo "[ERROR] curl is required"
  exit 1
fi

TODAY_UTC="$(date -u +%F)"
STARTED_AT="${TODAY_UTC}T09:00:00Z"
ENDED_AT="${TODAY_UTC}T10:00:00Z"

PAYLOAD="{\"org_id\":\"org-001\",\"user_id\":\"user-001\",\"session_id\":\"session-demo-001\",\"project_id\":\"proj-capstone-2027\",\"task\":\"Build production CDI backend\",\"started_at\":\"${STARTED_AT}\",\"ended_at\":\"${ENDED_AT}\",\"active_hours\":1.0,\"idle_hours\":0.1,\"cdi_score\":83.5,\"commit_count\":1,\"additions\":120,\"deletions\":15,\"commits\":[{\"commit_hash\":\"abc123\",\"message\":\"feat: add AWS telemetry ingestion\",\"additions\":120,\"deletions\":15}]}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "[1/6] Starting local backend on http://127.0.0.1:8000"
(
  cd "$SERVER_DIR"
  CDI_LOCAL_MODE=1 API_KEY_VALUE=local-dev-key PYTHONPATH=. python -m uvicorn src.dashboard_api:app --host 127.0.0.1 --port 8000
) >/tmp/cdi_backend.log 2>&1 &
SERVER_PID=$!

echo "[2/6] Waiting for /health"
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:8000/health >/tmp/cdi_health.json 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:8000/health >/tmp/cdi_health.json 2>/dev/null; then
  echo "[ERROR] Backend did not become healthy"
  echo "--- backend log ---"
  cat /tmp/cdi_backend.log
  exit 1
fi

cat /tmp/cdi_health.json

echo "[3/6] Posting sample telemetry"
curl -fsS -X POST http://127.0.0.1:8000/v1/telemetry/sync \
  -H "x-api-key: local-dev-key" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/tmp/cdi_sync.json
cat /tmp/cdi_sync.json

echo "[4/6] Querying dashboard after curl submit"
curl -fsS -H "x-api-key: local-dev-key" \
  "http://127.0.0.1:8000/v1/dashboard/user/org-001/user-001/${TODAY_UTC}" >/tmp/cdi_dashboard_before.json
cat /tmp/cdi_dashboard_before.json

echo "[5/6] Running Rust client against local API"
source "$HOME/.cargo/env"
(
  cd "$CLIENT_DIR"
  CDI_API_BASE_URL=http://127.0.0.1:8000 \
  CDI_API_KEY=local-dev-key \
  CDI_ORG_ID=org-001 \
  CDI_USER_ID=user-001 \
  cargo run --release
)

echo "[6/6] Querying dashboard after Rust client"
curl -fsS -H "x-api-key: local-dev-key" \
  "http://127.0.0.1:8000/v1/dashboard/user/org-001/user-001/${TODAY_UTC}" >/tmp/cdi_dashboard_after.json
cat /tmp/cdi_dashboard_after.json

echo "[DONE] Local end-to-end run completed"
