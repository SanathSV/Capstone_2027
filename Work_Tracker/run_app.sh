#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
SERVER_DIR="$ROOT_DIR/server-python"
CLIENT_DIR="$ROOT_DIR/client-rust"
BACKEND_PID=""
OLLAMA_PID=""

cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$OLLAMA_PID" ]] && kill -0 "$OLLAMA_PID" >/dev/null 2>&1; then
    kill "$OLLAMA_PID" >/dev/null 2>&1 || true
    wait "$OLLAMA_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ ! -x "$VENV_DIR/bin/python" ]] || ! "$VENV_DIR/bin/python" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)' >/dev/null 2>&1; then
  command -v python3.12 >/dev/null 2>&1 || {
    echo "Python 3.12 is required. Install it, then run this file again."
    exit 1
  }
  echo "Creating Python 3.12 environment..."
  rm -rf "$VENV_DIR"
  python3.12 -m venv "$VENV_DIR"
fi

PYTHON="$VENV_DIR/bin/python"
if ! "$PYTHON" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
  echo "Installing backend dependencies..."
  "$PYTHON" -m pip install --upgrade pip
  "$PYTHON" -m pip install -r "$SERVER_DIR/src/requirements.txt"
fi

if ! curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then
  echo "Starting local backend at http://127.0.0.1:8000"
  (
    cd "$SERVER_DIR"
    CDI_LOCAL_MODE=1 API_KEY_VALUE=local-dev-key PYTHONPATH=. \
      "$PYTHON" -m uvicorn src.dashboard_api:app --host 127.0.0.1 --port 8000
  ) >/tmp/work-tracker-backend.log 2>&1 &
  BACKEND_PID=$!

  for _ in {1..30}; do
    curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 || {
    echo "Backend failed to start. Log: /tmp/work-tracker-backend.log"
    cat /tmp/work-tracker-backend.log
    exit 1
  }
else
  echo "Using existing backend at http://127.0.0.1:8000"
fi

if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  command -v ollama >/dev/null 2>&1 || {
    echo "Ollama is required. Install Ollama, then run this file again."
    exit 1
  }
  echo "Starting Ollama..."
  ollama serve >/tmp/work-tracker-ollama.log 2>&1 &
  OLLAMA_PID=$!
  for _ in {1..30}; do
    curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 || {
    echo "Ollama failed to start. Log: /tmp/work-tracker-ollama.log"
    cat /tmp/work-tracker-ollama.log
    exit 1
  }
else
  echo "Using existing Ollama service"
fi

if ! curl -fsS http://127.0.0.1:11434/api/tags | grep -q 'llama3.2'; then
  echo "Downloading Ollama model llama3.2 (first run only)..."
  ollama pull llama3.2
fi

echo "Launching Focus Alignment Tracker..."
cd "$CLIENT_DIR"
CDI_API_BASE_URL=http://127.0.0.1:8000 \
CDI_API_KEY=local-dev-key \
CDI_ORG_ID=org-001 \
CDI_USER_ID=user-001 \
OLLAMA_MODEL=llama3.2 \
cargo run
