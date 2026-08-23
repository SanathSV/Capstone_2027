#!/usr/bin/env python3
"""
server.py -- HTTP control plane for the Meet caption bot.

Runs inside the container, owns the browser, and exposes a small JSON API:

    GET    /api/health                        liveness + whether creds are present
    POST   /api/join      {"url", "name"}     start a bot in a meeting
    GET    /api/sessions                      list every session
    GET    /api/sessions/{id}                 one session's status
    GET    /api/sessions/{id}/transcript      lines, incremental via ?since=N
    POST   /api/sessions/{id}/leave           hang up now
    DELETE /api/sessions/{id}                 forget a finished session

Credentials come from a Google profile directory produced by running
`python meet_listener.py --login` on a machine with a screen, then mounted into
the container at MEET_PROFILE_DIR. The container never logs in by itself.

Auth: if MEET_API_KEY is set, every /api route requires a matching X-API-Key
header. Unset means open, which is only sane on a private network.

    python server.py --host 0.0.0.0 --port 8080
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import signal
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from aiohttp import ClientSession, ClientTimeout, web
from playwright.async_api import async_playwright

import meet_listener as ml

API_KEY = os.environ.get("MEET_API_KEY", "")
PROFILE_DIR = Path(os.environ.get("MEET_PROFILE_DIR", str(ml.USER_DATA_DIR)))
DATA_DIR = Path(os.environ.get("MEET_DATA_DIR", "data"))
MAX_SESSIONS = int(os.environ.get("MEET_MAX_SESSIONS", "1"))
HEADLESS = os.environ.get("MEET_HEADLESS", "0") not in ("0", "", "false", "False")
# Test hook: lets the suite point a session at a local mock page instead of a
# real meeting. Never enable in production -- it turns the join endpoint into an
# open "fetch any URL in a browser" service.
ALLOW_ANY_URL = os.environ.get("MEET_ALLOW_ANY_URL", "0") not in ("0", "", "false", "False")

# Push target on the host. The container POSTs transcript batches here as they
# are produced, so nothing has to poll. From inside Docker Desktop the host is
# reachable as host.docker.internal; docker-compose maps that on Linux too.
CALLBACK_URL = os.environ.get("MEET_CALLBACK_URL", "")
CALLBACK_KEY = os.environ.get("MEET_CALLBACK_KEY", "")
CALLBACK_BATCH_SECONDS = float(os.environ.get("MEET_CALLBACK_BATCH_SECONDS", "1.0"))
CALLBACK_MAX_QUEUE = 5000
# Use the mounted Google account and nothing else. On by default: a silent
# guest fallback produces a bot that joins and is never admitted, with the real
# cause (an empty profile) nowhere in the logs.
REQUIRE_LOGIN = os.environ.get("MEET_REQUIRE_LOGIN", "1") not in ("0", "", "false", "False")
CHANNEL = os.environ.get("MEET_CHANNEL", "chrome")
# Browser caches are large and worthless in a copy; skip them.
PROFILE_COPY_IGNORE = shutil.ignore_patterns(
    "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache",
    "Crashpad", "BrowserMetrics", "component_crx_cache", "extensions_crx_cache",
    "DawnGraphiteCache", "DawnWebGPUCache",
    # Never copy Chrome's singleton locks: they name the host and pid that held
    # them, and a copied one is stale by definition.
    "Singleton*",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def credentials_present() -> bool:
    """Whether the mounted profile holds a Google session.

    Delegates to meet_listener so the container and the CLI agree on what
    "signed in" means, including which cookie-store layout to look at.
    """
    return ml.profile_has_google_session(PROFILE_DIR)


@dataclass
class Session:
    id: str
    url: str
    name: str
    state: str = "starting"          # starting|joining|listening|ended|failed
    created_at: str = field(default_factory=now_iso)
    ended_at: Optional[str] = None
    exit_code: Optional[int] = None
    error: Optional[str] = None
    lines: List[Dict[str, Any]] = field(default_factory=list)
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task] = None

    # Push-to-host plumbing.
    callback_url: str = ""
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    push_done: asyncio.Event = field(default_factory=asyncio.Event)
    pushed: int = 0
    push_failures: int = 0
    dropped: int = 0

    # Progress reporting: what the bot is doing right now, plus the trail.
    stage: str = "queued"
    stage_message: str = "Waiting to start"
    # Live assistant state, so the extension can show that Astra is awake.
    assistant: Dict[str, Any] = field(default_factory=dict)
    events: List[Dict[str, str]] = field(default_factory=list)

    def summary(self) -> Dict[str, Any]:
        return {
            "session_id": self.id,
            "url": self.url,
            "name": self.name,
            "state": self.state,
            "created_at": self.created_at,
            "ended_at": self.ended_at,
            "exit_code": self.exit_code,
            "error": self.error,
            "line_count": len(self.lines),
            "stage": self.stage,
            "stage_message": self.stage_message,
            "assistant": self.assistant,
            "events": self.events[-12:],
            "callback_url": self.callback_url,
            "pushed": self.pushed,
            "push_failures": self.push_failures,
            "dropped": self.dropped,
        }

    def set_assistant(self, status: Dict[str, Any]) -> None:
        self.assistant = status

    def set_stage(self, code: str, message: str) -> None:
        self.stage = code
        self.stage_message = message
        self.events.append({"ts": now_iso(), "stage": code, "message": message})

    def enqueue(self, record: Dict[str, Any]) -> None:
        """Record a finished line and hand a copy to the push pump."""
        self.lines.append(record)
        if not self.callback_url:
            return
        if self.queue.qsize() >= CALLBACK_MAX_QUEUE:
            # The host listener is gone or hopelessly behind. Drop rather than
            # grow without bound -- transcription must not stall on delivery.
            self.dropped += 1
            return
        self.queue.put_nowait(record)


class SessionManager:
    """Owns every running bot and the browser context each one drives."""

    def __init__(self, playwright) -> None:
        self._pw = playwright
        self._sessions: Dict[str, Session] = {}
        self._lock = asyncio.Lock()
        self._http: Optional[ClientSession] = None
        DATA_DIR.mkdir(parents=True, exist_ok=True)

    # -- queries -------------------------------------------------------------
    def get(self, session_id: str) -> Optional[Session]:
        return self._sessions.get(session_id)

    def all(self) -> List[Session]:
        return list(self._sessions.values())

    def active(self) -> List[Session]:
        return [s for s in self._sessions.values()
                if s.state in ("starting", "joining", "listening")]

    def drop(self, session_id: str) -> bool:
        session = self._sessions.get(session_id)
        if not session or session.state in ("starting", "joining", "listening"):
            return False
        del self._sessions[session_id]
        return True

    # -- lifecycle -----------------------------------------------------------
    async def start(self, url: str, name: str, **overrides) -> Session:
        async with self._lock:
            if len(self.active()) >= MAX_SESSIONS:
                raise RuntimeError(
                    f"busy: {MAX_SESSIONS} session(s) already running. "
                    "Raise MEET_MAX_SESSIONS or run another container."
                )
            session = Session(id=uuid.uuid4().hex[:12], url=url, name=name)
            # Per-request override, otherwise the container-wide default.
            session.callback_url = str(overrides.pop("callback_url", "") or CALLBACK_URL)
            self._sessions[session.id] = session
            session.task = asyncio.create_task(self._run(session, overrides))
            return session

    async def stop_session(self, session_id: str) -> bool:
        session = self._sessions.get(session_id)
        if not session or session.state in ("ended", "failed"):
            return False
        session.stop.set()
        return True

    async def shutdown(self) -> None:
        for session in self.active():
            session.stop.set()
        tasks = [s.task for s in self.all() if s.task and not s.task.done()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._http is not None and not self._http.closed:
            await self._http.close()

    # -- push to the host listener -------------------------------------------
    async def _client(self) -> "ClientSession":
        if self._http is None or self._http.closed:
            self._http = ClientSession()
        return self._http

    async def _post(self, session: Session, event: str,
                    lines: List[Dict[str, Any]], attempts: int = 3) -> bool:
        payload = {
            "event": event,
            "session_id": session.id,
            "url": session.url,
            "name": session.name,
            "state": session.state,
            "stage": session.stage,
            "stage_message": session.stage_message,
            "assistant": session.assistant,
            "seq_start": session.pushed,
            "lines": lines,
            "line_count": len(session.lines),
            "error": session.error,
            "sent_at": now_iso(),
        }
        headers = {"X-API-Key": CALLBACK_KEY} if CALLBACK_KEY else {}
        for attempt in range(attempts):
            try:
                client = await self._client()
                async with client.post(session.callback_url, json=payload,
                                       headers=headers,
                                       timeout=ClientTimeout(total=10)) as response:
                    if response.status < 300:
                        session.pushed += len(lines)
                        return True
                    detail = (await response.text())[:200]
                    ml.log(f"[{session.id}] callback HTTP {response.status}: {detail}")
            except Exception as exc:
                if attempt == attempts - 1:
                    ml.log(f"[{session.id}] callback failed: {type(exc).__name__}: {exc}")
            await asyncio.sleep(0.5 * (attempt + 1))
        session.push_failures += 1
        return False

    async def _pusher(self, session: Session) -> None:
        """Drain the queue into the host listener in small batches.

        Runs alongside the bot and never blocks it: a slow or missing listener
        costs delivery, never transcription.
        """
        await self._post(session, "session_started", [])
        while True:
            batch: List[Dict[str, Any]] = []
            deadline = time.time() + CALLBACK_BATCH_SECONDS
            while len(batch) < 200:
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                try:
                    batch.append(await asyncio.wait_for(session.queue.get(),
                                                        timeout=remaining))
                except asyncio.TimeoutError:
                    break
            if batch:
                await self._post(session, "lines", batch)
            if session.push_done.is_set() and session.queue.empty():
                break
        await self._post(session, "session_ended", [])

    # -- the actual bot ------------------------------------------------------
    async def _profile_for(self, session: Session) -> Path:
        """Give the session a private working copy of the credentials.

        The mounted profile is never opened directly. Chrome writes a
        SingletonLock naming the host and pid that hold it, and refuses to open
        a profile locked by a different machine -- which is every container
        restart, since each container gets a new hostname. One unclean exit
        would otherwise poison the mounted credentials permanently.

        Copying also means the host can keep using ./creds while the container
        runs, and that concurrent sessions never fight over one directory.
        """
        target = DATA_DIR / "profiles" / session.id
        shutil.rmtree(target, ignore_errors=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        if PROFILE_DIR.exists():
            await asyncio.to_thread(
                shutil.copytree, PROFILE_DIR, target,
                ignore=PROFILE_COPY_IGNORE, dirs_exist_ok=True, symlinks=True,
            )
        else:
            target.mkdir(parents=True, exist_ok=True)
        return target

    async def _run(self, session: Session, overrides: Dict[str, Any]) -> None:
        transcript = DATA_DIR / "transcripts" / f"{session.id}.jsonl"
        transcript.parent.mkdir(parents=True, exist_ok=True)

        sink = ml.CaptionSink(
            jsonl_path=transcript,
            stable_after=float(overrides.get("stable_after", 1.5)),
            on_line=session.enqueue,
            echo=True,  # container logs stay useful
        )

        args = argparse.Namespace(
            url=session.url,
            guest=bool(overrides.get("guest", False)),
            display_name=session.name,
            join_timeout=float(overrides.get("join_timeout", 45)),
            admit_timeout=float(overrides.get("admit_timeout", 300)),
            max_minutes=float(overrides.get("max_minutes", 0)),
            stable_after=float(overrides.get("stable_after", 1.5)),
            alone_grace=float(overrides.get("alone_grace", 60)),
            assistant=bool(overrides.get(
                "assistant", os.environ.get("MEET_ASSISTANT", "0") not in ("0", "", "false"))),
            wake_words=str(overrides.get(
                "wake_words", os.environ.get("MEET_WAKE_WORDS", "astra,yo bot"))),
            ollama_url=str(overrides.get(
                "ollama_url",
                os.environ.get("MEET_OLLAMA_URL", "http://host.docker.internal:11434"))),
            ollama_model=str(overrides.get(
                "ollama_model", os.environ.get("MEET_OLLAMA_MODEL", "llama3.2"))),
            greeting=str(overrides.get("greeting", os.environ.get("MEET_GREETING", ""))),
            listen_window=float(overrides.get("listen_window", 20)),
            reply_silence=float(overrides.get("reply_silence", 4)),
            caption_language=str(overrides.get(
                "caption_language", os.environ.get("MEET_CAPTION_LANGUAGE", ""))),
            require_login=bool(overrides.get("require_login", REQUIRE_LOGIN)),
        )

        pusher = None
        if session.callback_url:
            pusher = asyncio.create_task(self._pusher(session))

        context = None
        browser = None
        profile_dir = None
        try:
            state_file = PROFILE_DIR / ml.STORAGE_STATE_NAME
            use_state = ml.storage_state_has_session(state_file)
            if use_state:
                session.set_stage("credentials",
                                  "Using exported storage_state.json (portable cookies)")
                profile_dir = None
            else:
                profile_dir = await self._profile_for(session)
            session.state = "joining"
            session.set_stage("launching_browser",
                              "Launching Chrome with a copy of the saved credentials")
            launch: Dict[str, Any] = dict(
                headless=HEADLESS,
                args=ml.CHROMIUM_ARGS,
                ignore_default_args=ml.IGNORED_DEFAULT_ARGS,
                permissions=["microphone", "camera"],
                locale="en-US",
                no_viewport=not HEADLESS,
                viewport={"width": 1440, "height": 900} if HEADLESS else None,
            )
            if CHANNEL:
                launch["channel"] = CHANNEL
            context_opts = {k: launch.pop(k) for k in
                            ("permissions", "locale", "no_viewport", "viewport")
                            if k in launch}
            if use_state:
                # A Chrome profile is not portable across operating systems --
                # its cookies are encrypted under an OS-specific key -- so the
                # container seeds a fresh browser with exported cookies instead.
                try:
                    browser = await self._pw.chromium.launch(**launch)
                except Exception:
                    launch.pop("channel", None)
                    browser = await self._pw.chromium.launch(**launch)
                context = await browser.new_context(
                    storage_state=str(state_file), **context_opts)
            else:
                launch["user_data_dir"] = str(profile_dir)
                launch.update(context_opts)
                try:
                    context = await self._pw.chromium.launch_persistent_context(**launch)
                except Exception:
                    launch.pop("channel", None)
                    context = await self._pw.chromium.launch_persistent_context(**launch)

            await context.add_init_script(ml.STEALTH_JS)
            context.set_default_timeout(20_000)
            session.state = "listening"

            session.set_stage("browser_ready", "Chrome is up; opening the meeting")
            code = await ml.run_meeting(
                context, args, sink, stop=session.stop, manage_signals=False,
                on_status=session.set_stage,
                on_assistant=session.set_assistant,
            )
            session.exit_code = code
            session.state = "ended" if code == 0 else "failed"
            if code != 0:
                session.error = ml.EXIT_REASONS.get(code, f"exit code {code}")
            session.set_stage(session.state,
                              session.error or "Finished and left the call")
        except Exception as exc:
            session.state = "failed"
            session.error = f"{type(exc).__name__}: {exc}"
            session.set_stage("failed", session.error)
            ml.log(f"[{session.id}] session failed: {session.error}")
        finally:
            session.ended_at = now_iso()
            for closeable in (context, browser):
                if closeable is not None:
                    try:
                        await closeable.close()
                    except Exception:
                        pass
            session.push_done.set()
            if pusher is not None:
                try:
                    await asyncio.wait_for(pusher, timeout=30)
                except Exception:
                    pusher.cancel()
            if profile_dir and profile_dir != PROFILE_DIR:
                shutil.rmtree(profile_dir, ignore_errors=True)
            ml.log(f"[{session.id}] {session.state}, {len(session.lines)} line(s)")


# --------------------------------------------------------------------------- #
# HTTP layer
# --------------------------------------------------------------------------- #

CORS_HEADERS = {
    "Access-Control-Allow-Origin": os.environ.get("MEET_CORS_ORIGIN", "*"),
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
}


def json_response(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, headers=CORS_HEADERS)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=CORS_HEADERS)
    if API_KEY and request.path.startswith("/api/") and request.path != "/api/health":
        if request.headers.get("X-API-Key") != API_KEY:
            return json_response({"error": "unauthorized"}, status=401)
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception as exc:  # never leak a traceback to the caller
        ml.log(f"unhandled error on {request.path}: {type(exc).__name__}: {exc}")
        return json_response({"error": "internal error"}, status=500)


def manager(request: web.Request) -> SessionManager:
    return request.app["manager"]


async def handle_health(request: web.Request) -> web.Response:
    return json_response({
        "ok": True,
        "time": now_iso(),
        "profile_dir": str(PROFILE_DIR),
        "credentials_present": credentials_present(),
        "require_login": REQUIRE_LOGIN,
        "headless": HEADLESS,
        "max_sessions": MAX_SESSIONS,
        "active_sessions": len(manager(request).active()),
        "auth_required": bool(API_KEY),
    })


async def handle_join(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return json_response({"error": "body must be JSON"}, status=400)

    url = (body.get("url") or "").strip()
    if not url:
        return json_response({"error": "missing 'url'"}, status=400)
    if "meet.google.com" not in url and not ALLOW_ANY_URL:
        return json_response({"error": "not a Google Meet URL"}, status=400)

    if REQUIRE_LOGIN and not credentials_present():
        return json_response({
            "error": "no Google session in the mounted profile, and this server is "
                     "configured to use the signed-in account only. Run "
                     "`python meet_listener.py --login --profile ./creds` on a "
                     "machine with a screen, confirm it prints 'Signed in.', then "
                     "restart the container.",
            "profile_dir": str(PROFILE_DIR),
        }, status=409)

    name = (body.get("name") or ml.DISPLAY_NAME).strip()
    overrides = {k: body[k] for k in
                 ("guest", "max_minutes", "stable_after", "alone_grace",
                  "join_timeout", "admit_timeout", "callback_url",
                  "caption_language", "assistant", "wake_words",
                  "ollama_url", "ollama_model", "greeting") if k in body}
    if REQUIRE_LOGIN:
        overrides["guest"] = False        # a guest join is exactly what we forbid
        overrides["require_login"] = True
    try:
        session = await manager(request).start(url, name, **overrides)
    except RuntimeError as exc:
        return json_response({"error": str(exc)}, status=409)
    return json_response(session.summary(), status=201)


async def handle_list(request: web.Request) -> web.Response:
    return json_response({"sessions": [s.summary() for s in manager(request).all()]})


async def handle_get(request: web.Request) -> web.Response:
    session = manager(request).get(request.match_info["sid"])
    if not session:
        return json_response({"error": "no such session"}, status=404)
    return json_response(session.summary())


async def handle_transcript(request: web.Request) -> web.Response:
    session = manager(request).get(request.match_info["sid"])
    if not session:
        return json_response({"error": "no such session"}, status=404)
    try:
        since = max(0, int(request.query.get("since", "0")))
    except ValueError:
        since = 0
    lines = session.lines[since:]
    payload = session.summary()
    payload.update({
        "since": since,
        "next": since + len(lines),   # feed straight back as ?since= to poll
        "lines": lines,
        "text": "\n".join(f"{l['speaker']}: {l['text']}" for l in lines),
    })
    return json_response(payload)


async def handle_leave(request: web.Request) -> web.Response:
    sid = request.match_info["sid"]
    if not manager(request).get(sid):
        return json_response({"error": "no such session"}, status=404)
    stopped = await manager(request).stop_session(sid)
    return json_response({"session_id": sid, "stopping": stopped})


async def handle_delete(request: web.Request) -> web.Response:
    sid = request.match_info["sid"]
    session = manager(request).get(sid)
    if not session:
        return json_response({"error": "no such session"}, status=404)
    if not manager(request).drop(sid):
        return json_response({"error": "session still running; leave it first"},
                             status=409)
    return json_response({"deleted": sid})


async def handle_index(request: web.Request) -> web.Response:
    return json_response({
        "service": "meet-listener",
        "endpoints": [
            "GET  /api/health",
            "POST /api/join {url, name}",
            "GET  /api/sessions",
            "GET  /api/sessions/{id}",
            "GET  /api/sessions/{id}/transcript?since=N",
            "POST /api/sessions/{id}/leave",
            "DELETE /api/sessions/{id}",
        ],
    })


def build_app(playwright) -> web.Application:
    app = web.Application(middlewares=[auth_middleware])
    app["manager"] = SessionManager(playwright)
    app.add_routes([
        web.get("/", handle_index),
        web.get("/api/health", handle_health),
        web.post("/api/join", handle_join),
        web.get("/api/sessions", handle_list),
        web.get("/api/sessions/{sid}", handle_get),
        web.get("/api/sessions/{sid}/transcript", handle_transcript),
        web.post("/api/sessions/{sid}/leave", handle_leave),
        web.delete("/api/sessions/{sid}", handle_delete),
        web.route("OPTIONS", "/{tail:.*}",
                  lambda r: web.Response(status=204, headers=CORS_HEADERS)),
    ])
    return app


async def amain(host: str, port: int) -> None:
    async with async_playwright() as pw:
        app = build_app(pw)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host, port)
        await site.start()

        ml.log(f"Listening on http://{host}:{port}")
        ml.log(f"Profile: {PROFILE_DIR} (credentials present: {credentials_present()})")
        ml.log(f"Account mode: {'signed-in profile ONLY' if REQUIRE_LOGIN else 'guest fallback allowed'}")
        if not credentials_present():
            if REQUIRE_LOGIN:
                ml.log("REFUSING JOINS: no Google session in the mounted profile. Run "
                       "`python meet_listener.py --login --profile ./creds` on a machine "
                       "with a screen, then restart this container.")
            else:
                ml.log("WARNING: no Google session in the profile; bots will join as guests.")
        ml.log(f"Auth: {'X-API-Key required' if API_KEY else 'OPEN (set MEET_API_KEY)'}")

        # As PID 1 in the container, a signal with no handler installed is
        # ignored outright -- without this, `docker stop` would wait out its
        # full timeout and then SIGKILL, cutting sessions off mid-transcript.
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except (NotImplementedError, AttributeError, ValueError):
                signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))

        try:
            await stop.wait()
            ml.log("Signal received; shutting down.")
        finally:
            await app["manager"].shutdown()
            await runner.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser(description="Meet caption bot API server.")
    parser.add_argument("--host", default=os.environ.get("MEET_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MEET_PORT", "8080")))
    opts = parser.parse_args()
    try:
        asyncio.run(amain(opts.host, opts.port))
    except KeyboardInterrupt:
        ml.log("Shutting down.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
