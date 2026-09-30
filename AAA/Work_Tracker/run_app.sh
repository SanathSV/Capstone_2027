#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
SERVER_DIR="$ROOT_DIR/server-python"
CLIENT_DIR="$ROOT_DIR/client-rust"

BACKEND_PID=""
OLLAMA_PID=""

BACKEND_LOG="$ROOT_DIR/work-tracker-backend.log"
OLLAMA_LOG="$ROOT_DIR/work-tracker-ollama.log"

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


# ============================================================
# Python 3.12 virtual environment
# ============================================================

PYTHON_EXE="$VENV_DIR/Scripts/python.exe"

if [[ ! -x "$PYTHON_EXE" ]] || \
   ! "$PYTHON_EXE" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)' >/dev/null 2>&1; then

  command -v python3.12 >/dev/null 2>&1 || {
    echo "Python 3.12 is required. Install it, then run this file again."
    exit 1
  }

  echo "Creating Python 3.12 environment..."

  rm -rf "$VENV_DIR"

  python3.12 -m venv "$VENV_DIR"

  PYTHON_EXE="$VENV_DIR/Scripts/python.exe"
fi


# ============================================================
# Backend dependencies
# ============================================================

if ! "$PYTHON_EXE" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
  echo "Installing backend dependencies..."

  "$PYTHON_EXE" -m pip install --upgrade pip

  "$PYTHON_EXE" -m pip install \
    -r "$SERVER_DIR/src/requirements.txt"
fi


# ============================================================
# Start Python backend
# ============================================================

if ! curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then

  echo "Starting local backend at http://127.0.0.1:8000"

  (
    cd "$SERVER_DIR"

    CDI_LOCAL_MODE=1 \
    API_KEY_VALUE=local-dev-key \
    PYTHONPATH=. \
    "$PYTHON_EXE" \
      -m uvicorn \
      src.dashboard_api:app \
      --host 127.0.0.1 \
      --port 8000

  ) >"$BACKEND_LOG" 2>&1 &

  BACKEND_PID=$!

  echo "Waiting for backend..."

  for _ in {1..30}; do
    if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then
      break
    fi

    sleep 1
  done

  if ! curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then

    echo ""
    echo "Backend failed to start."
    echo "Log: $BACKEND_LOG"
    echo ""

    cat "$BACKEND_LOG"

    exit 1
  fi

  echo "Backend started successfully."

else

  echo "Using existing backend at http://127.0.0.1:8000"

fi


# ============================================================
# Start Ollama
# ============================================================

if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then

  command -v ollama >/dev/null 2>&1 || {
    echo "Ollama is required. Install Ollama, then run this file again."
    exit 1
  }

  echo "Starting Ollama..."

  ollama serve >"$OLLAMA_LOG" 2>&1 &

  OLLAMA_PID=$!

  echo "Waiting for Ollama..."

  for _ in {1..30}; do
    if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      break
    fi

    sleep 1
  done

  if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then

    echo ""
    echo "Ollama failed to start."
    echo "Log: $OLLAMA_LOG"
    echo ""

    cat "$OLLAMA_LOG"

    exit 1
  fi

  echo "Ollama started successfully."

else

  echo "Using existing Ollama service"

fi


# ============================================================
# Check / download llama3.2
# ============================================================

if ! curl -fsS http://127.0.0.1:11434/api/tags | grep -q 'llama3.2'; then

  echo "Downloading Ollama model llama3.2 (first run only)..."

  ollama pull llama3.2

else

  echo "Ollama model llama3.2 is already installed."

fi


# ============================================================
# Launch Rust client
# ============================================================

echo ""
echo "Launching Focus Alignment Tracker..."
echo ""

cd "$CLIENT_DIR"

CDI_API_BASE_URL=http://127.0.0.1:8000 \
CDI_API_KEY=local-dev-key \
CDI_ORG_ID=org-001 \
CDI_USER_ID=user-001 \
OLLAMA_MODEL=llama3.2 \
cargo run