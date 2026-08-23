"""Integration test for the push path: container server -> host listener.

Starts host_listener.py and server.py as separate processes, sends a bot into
the mock meeting, and asserts the transcript arrives at the host WITHOUT anyone
polling for it -- lines, lifecycle events, auth, and files on disk.

    python tests/test_push.py
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import tester  # noqa: E402

API_PORT = int(os.environ.get("TEST_API_PORT", "8098"))
SINK_PORT = int(os.environ.get("TEST_SINK_PORT", "9098"))
API = f"http://127.0.0.1:{API_PORT}"
SINK = f"http://127.0.0.1:{SINK_PORT}"
KEY = "api-key-123"
CALLBACK_KEY = "callback-key-456"
PAGE = (ROOT / "tests" / "fake_meet.html").as_uri()
OUT = ROOT / "data" / "test-received"
FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        print(f"         got:  {got!r}\n         want: {want!r}")
        FAILURES.append(label)


def wait_for(fn, what, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return fn()
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"{what} did not come up in time")


def main() -> int:
    shutil.rmtree(OUT, ignore_errors=True)
    env = dict(os.environ, PYTHONUNBUFFERED="1")

    sink = subprocess.Popen(
        [sys.executable, str(ROOT / "host_listener.py"),
         "--host", "127.0.0.1", "--port", str(SINK_PORT),
         "--key", CALLBACK_KEY, "--out", str(OUT)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

    api = subprocess.Popen(
        [sys.executable, str(ROOT / "server.py"),
         "--host", "127.0.0.1", "--port", str(API_PORT)],
        env=dict(env, **{
            "MEET_API_KEY": KEY,
            "MEET_ALLOW_ANY_URL": "1",
        # The mock page is not Google, so there is no account to sign into.
        "MEET_REQUIRE_LOGIN": "0",
            "MEET_PROFILE_DIR": str(ROOT / "data" / "test-profile"),
            "MEET_DATA_DIR": str(ROOT / "data" / "test-data"),
            "MEET_MAX_SESSIONS": "1",
            "MEET_CHANNEL": "chrome",
            # The whole point: push everything to the host listener.
            "MEET_CALLBACK_URL": f"{SINK}/ingest",
            "MEET_CALLBACK_KEY": CALLBACK_KEY,
            "MEET_CALLBACK_BATCH_SECONDS": "0.5",
        }),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

    try:
        print("\n1. Both processes start")
        wait_for(lambda: tester.call(SINK, "GET", "/sessions", timeout=3),
                 "host listener")
        health = wait_for(lambda: tester.call(API, "GET", "/api/health", timeout=3),
                          "api server")
        check("api server healthy", health["ok"], True)
        check("host listener has no sessions yet",
              tester.call(SINK, "GET", "/sessions")["sessions"], [])

        print("\n2. The host listener rejects unauthenticated pushes")
        try:
            tester.call(SINK, "POST", "/ingest", body={"session_id": "x"})
            unauth = "allowed"
        except tester.ApiError as exc:
            unauth = "rejected" if "401" in str(exc) else f"other: {exc}"
        check("a push without the callback key is rejected", unauth, "rejected")

        print("\n3. Send a bot in -- nobody polls for the transcript")
        session = tester.call(API, "POST", "/api/join", KEY, {
            "url": PAGE, "name": "BOT1", "guest": True,
            "stable_after": 0.6, "max_minutes": 0.4, "alone_grace": 0,
        })
        sid = session["session_id"]
        check("session reports its callback target",
              session["callback_url"], f"{SINK}/ingest")

        print("\n4. Waiting for the host listener to receive it")
        deadline, received = time.time() + 120, None
        while time.time() < deadline:
            sessions = tester.call(SINK, "GET", "/sessions")["sessions"]
            received = next((s for s in sessions if s["session_id"] == sid), None)
            if received and received["state"] in ("ended", "failed"):
                break
            time.sleep(1.5)

        check("the host listener saw the session", bool(received), True)
        if received:
            check("session reached the host as ended", received["state"], "ended")
            check("all three lines were pushed", received["received"], 3)
            check("the meeting URL came across", received["url"], PAGE)

        print("\n5. Transcript files written on the host")
        txt, jsonl = OUT / f"{sid}.txt", OUT / f"{sid}.jsonl"
        check("text transcript exists", txt.exists(), True)
        check("jsonl transcript exists", jsonl.exists(), True)
        if jsonl.exists():
            records = [json.loads(l) for l in
                       jsonl.read_text(encoding="utf-8").splitlines() if l.strip()]
            check("received line content",
                  [f"{r['speaker']}: {r['text']}" for r in records], [
                      "Alice Chen: So I think we should ship it",
                      "Alice Chen: on Friday",
                      "Bob Ortiz: Agreed, let's do it",
                  ])
            check("continuation flag survived the hop",
                  [r["continuation"] for r in records], [False, True, False])
        if txt.exists():
            check("text file renders the continuation marker",
                  "...on Friday" in txt.read_text(encoding="utf-8"), True)

        print("\n6. The container recorded a clean delivery")
        final = tester.call(API, "GET", f"/api/sessions/{sid}", KEY)
        check("no push failures", final["push_failures"], 0)
        check("nothing dropped", final["dropped"], 0)
        check("pushed count matches", final["pushed"], 3)

    finally:
        for proc, label in ((api, "api server"), (sink, "host listener")):
            proc.terminate()
            try:
                out, _ = proc.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                out, _ = proc.communicate()
            if FAILURES:
                print(f"\n--- {label} log ---\n{out[-2500:]}")

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S): " + ", ".join(FAILURES))
        return 1
    print("ALL CHECKS PASSED")
    return 0


raise SystemExit(main())
