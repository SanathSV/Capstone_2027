#!/usr/bin/env python3
"""
host_listener.py -- runs on YOUR machine and receives transcripts pushed by the
container.

The container does not wait to be asked: as the bot hears things, it POSTs
batches of caption lines here. This process prints them live and writes them to
disk, so the transcript ends up on the host even though the browser ran inside
Docker.

    python host_listener.py                     # listen on 0.0.0.0:9000
    python host_listener.py --port 9000 --key secret123 --out transcripts

Then point the container at it:

    MEET_CALLBACK_URL=http://host.docker.internal:9000/ingest
    MEET_CALLBACK_KEY=secret123

Endpoints:
    POST /ingest       what the container pushes to
    GET  /            human-readable status
    GET  /sessions    JSON: every session seen and how many lines arrived
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from aiohttp import web

for _stream in (sys.stdout, sys.stderr):
    # Captions can be in any script; a legacy console codepage would raise
    # UnicodeEncodeError on the first non-Latin character.
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ANSI colours, disabled when piped so redirected output stays clean.
COLOR = sys.stdout.isatty()
DIM = "\033[2m" if COLOR else ""
BOLD = "\033[1m" if COLOR else ""
CYAN = "\033[36m" if COLOR else ""
GREEN = "\033[32m" if COLOR else ""
RED = "\033[31m" if COLOR else ""
RESET = "\033[0m" if COLOR else ""


def stamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


class Receiver:
    """Keeps what arrived, per session, and mirrors it to disk."""

    def __init__(self, out_dir: Path) -> None:
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.sessions: Dict[str, Dict[str, Any]] = {}

    def _session(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        sid = payload["session_id"]
        if sid not in self.sessions:
            self.sessions[sid] = {
                "session_id": sid,
                "url": payload.get("url", ""),
                "name": payload.get("name", ""),
                "state": payload.get("state", ""),
                "first_seen": stamp(),
                "received": 0,
                "stage": "",
                "astra": "",
                "lines": [],
            }
        return self.sessions[sid]

    def handle(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        session = self._session(payload)
        session["state"] = payload.get("state", session["state"])
        event = payload.get("event", "lines")

        # Progress reporting: print each stage once, as it changes.
        stage = payload.get("stage", "")
        if stage and stage != session.get("stage"):
            session["stage"] = stage
            message = payload.get("stage_message") or stage
            print(f"{DIM}[{stamp()} {payload['session_id'][:8]}]{RESET} "
                  f"{CYAN}* {message}{RESET}", flush=True)
        sid = session["session_id"]
        short = sid[:8]

        if event == "session_started":
            print(f"\n{BOLD}{CYAN}== session {short} started =={RESET}")
            print(f"{DIM}   {session['url']}{RESET}")
            print(f"{DIM}   bot name: {session['name']}{RESET}\n")

        # Astra activity, printed once per change like the stage line.
        bot = payload.get("assistant") or {}
        if bot.get("state") and bot.get("state") != session.get("astra"):
            session["astra"] = bot["state"]
            if bot["state"] != "idle":
                print(f"{DIM}[{stamp()} {short}]{RESET} "
                      f"{CYAN}~ Astra {bot.get('label', bot['state'])}{RESET}", flush=True)
            elif bot.get("last_answer"):
                print(f"{DIM}[{stamp()} {short}]{RESET} "
                      f"{GREEN}~ Astra answered: {bot['last_answer'][:100]}{RESET}", flush=True)

        lines: List[Dict[str, Any]] = payload.get("lines") or []
        for line in lines:
            marker = "..." if line.get("continuation") else ""
            print(f"{DIM}[{stamp()} {short}]{RESET} "
                  f"{BOLD}{line.get('speaker', '?')}{RESET}: {marker}{line.get('text', '')}",
                  flush=True)
            session["lines"].append(line)
            session["received"] += 1

        if lines:
            self._write(sid, lines)

        if event == "session_ended":
            state = payload.get("state", "?")
            error = payload.get("error")
            colour = RED if state == "failed" else GREEN
            print(f"\n{colour}== session {short} {state}"
                  f"{': ' + error if error else ''} "
                  f"-- {session['received']} line(s) received =={RESET}")
            print(f"{DIM}   saved to {self.out_dir / (sid + '.txt')}{RESET}\n")

        return {"ok": True, "received": session["received"]}

    def _write(self, sid: str, lines: List[Dict[str, Any]]) -> None:
        with (self.out_dir / f"{sid}.jsonl").open("a", encoding="utf-8") as fh:
            for line in lines:
                fh.write(json.dumps(line, ensure_ascii=False) + "\n")
        with (self.out_dir / f"{sid}.txt").open("a", encoding="utf-8") as fh:
            for line in lines:
                marker = "..." if line.get("continuation") else ""
                fh.write(f"[{line.get('ts', '')}] {line.get('speaker', '?')}: "
                         f"{marker}{line.get('text', '')}\n")


async def handle_ingest(request: web.Request) -> web.Response:
    key = request.app["key"]
    if key and request.headers.get("X-API-Key") != key:
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "body must be JSON"}, status=400)
    if not payload.get("session_id"):
        return web.json_response({"error": "missing session_id"}, status=400)
    return web.json_response(request.app["receiver"].handle(payload))


async def handle_sessions(request: web.Request) -> web.Response:
    receiver = request.app["receiver"]
    return web.json_response({
        "sessions": [
            {k: v for k, v in s.items() if k != "lines"}
            for s in receiver.sessions.values()
        ]
    })


async def handle_index(request: web.Request) -> web.Response:
    receiver = request.app["receiver"]
    rows = "\n".join(
        f"  {s['session_id'][:8]}  {s['state']:<10} {s['received']:>5} lines  {s['url']}"
        for s in receiver.sessions.values()
    ) or "  (nothing received yet)"
    return web.Response(text=(
        "meet host listener\n"
        f"output directory: {receiver.out_dir.resolve()}\n"
        f"auth: {'required' if request.app['key'] else 'open'}\n\n"
        f"sessions:\n{rows}\n"
    ))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Receive transcripts pushed from the meet-listener container.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--host", default="0.0.0.0",
                        help="Bind address. Must be reachable from the container.")
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("MEET_LISTENER_PORT", "9000")))
    parser.add_argument("--key", default=os.environ.get("MEET_CALLBACK_KEY", ""),
                        help="Shared secret the container must send as X-API-Key.")
    parser.add_argument("--out", default="transcripts",
                        help="Directory for received transcripts.")
    args = parser.parse_args()

    app = web.Application()
    app["receiver"] = Receiver(Path(args.out))
    app["key"] = args.key
    app.add_routes([
        web.post("/ingest", handle_ingest),
        web.get("/sessions", handle_sessions),
        web.get("/", handle_index),
    ])

    print(f"{BOLD}Host listener ready{RESET}")
    print(f"  listening   : http://{args.host}:{args.port}/ingest")
    print(f"  saving to   : {Path(args.out).resolve()}")
    print(f"  auth        : {'required' if args.key else 'OPEN (use --key)'}")
    print(f"\n  point the container at it with:")
    print(f"    MEET_CALLBACK_URL=http://host.docker.internal:{args.port}/ingest")
    if args.key:
        print(f"    MEET_CALLBACK_KEY={args.key}")
    print("\nwaiting for transcripts... (Ctrl+C to stop)\n")

    try:
        web.run_app(app, host=args.host, port=args.port, print=None)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
