"""Integration test: real server process + real tester.py client.

Starts server.py as a subprocess, drives it exactly the way the extension and
tester.py do (HTTP + X-API-Key), sends a bot into the mock Meet page, and
follows the transcript through the incremental ?since= endpoint.

    python tests/test_server.py
"""
import json
import os
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import tester  # noqa: E402  (the actual client, not a reimplementation)

PORT = int(os.environ.get("TEST_PORT", "8099"))
SERVER = f"http://127.0.0.1:{PORT}"
KEY = "test-key-123"
PAGE = (ROOT / "tests" / "fake_meet.html").as_uri()
FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        print(f"         got:  {got!r}\n         want: {want!r}")
        FAILURES.append(label)


def wait_for_server(proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early with code {proc.returncode}")
        try:
            return tester.call(SERVER, "GET", "/api/health", timeout=3)
        except tester.ApiError:
            time.sleep(0.5)
    raise RuntimeError("server did not come up in time")


def main() -> int:
    env = dict(os.environ)
    env.update({
        "MEET_API_KEY": KEY,
        "MEET_ALLOW_ANY_URL": "1",
        # The mock page is not Google, so there is no account to sign into.
        "MEET_REQUIRE_LOGIN": "0",          # let the bot open the mock page
        "MEET_PROFILE_DIR": str(ROOT / "data" / "test-profile"),
        "MEET_DATA_DIR": str(ROOT / "data" / "test-data"),
        "MEET_MAX_SESSIONS": "1",
        "MEET_CHANNEL": "chrome",
        "PYTHONUNBUFFERED": "1",
    })
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
         "--port", str(PORT)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

    try:
        print("\n1. Server startup")
        health = wait_for_server(proc)
        check("health reports ok", health["ok"], True)
        check("auth is required", health["auth_required"], True)
        check("no session running yet", health["active_sessions"], 0)

        print("\n2. Authentication")
        try:
            tester.call(SERVER, "GET", "/api/sessions")   # no key
            unauth = "allowed"
        except tester.ApiError as exc:
            unauth = "rejected" if "401" in str(exc) else f"other: {exc}"
        check("a request without the key is rejected", unauth, "rejected")
        listing = tester.call(SERVER, "GET", "/api/sessions", KEY)
        check("a request with the key succeeds", listing, {"sessions": []})

        print("\n3. Input validation")
        try:
            tester.call(SERVER, "POST", "/api/join", KEY, {"name": "x"})
            missing = "accepted"
        except tester.ApiError as exc:
            missing = "rejected" if "400" in str(exc) else f"other: {exc}"
        check("a join with no URL is rejected", missing, "rejected")

        print("\n3b. Signed-in-only mode refuses rather than joining anonymously")
        strict = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
             "--port", str(PORT + 1)],
            env=dict(env, MEET_REQUIRE_LOGIN="1"),   # the shipping default
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            strict_url = f"http://127.0.0.1:{PORT + 1}"
            deadline = time.time() + 60
            while time.time() < deadline:
                try:
                    info = tester.call(strict_url, "GET", "/api/health", timeout=3)
                    break
                except tester.ApiError:
                    time.sleep(0.5)
            check("strict server reports require_login", info["require_login"], True)
            check("and knows the profile has no session",
                  info["credentials_present"], False)
            try:
                tester.call(strict_url, "POST", "/api/join", KEY, {"url": PAGE})
                refused = "accepted"
            except tester.ApiError as exc:
                refused = "rejected" if "409" in str(exc) else f"other: {exc}"
            check("a join on a signed-out profile is refused, not downgraded",
                  refused, "rejected")
        finally:
            strict.terminate()
            try:
                strict.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                strict.kill()
                strict.communicate()

        print("\n4. Joining the mock meeting")
        session = tester.call(SERVER, "POST", "/api/join", KEY, {
            "url": PAGE, "name": "BOT1", "guest": True,
            "stable_after": 0.6, "max_minutes": 0.4, "alone_grace": 0,
        })
        sid = session["session_id"]
        print(f"   session {sid}")
        check("session was created", bool(sid), True)

        busy = "allowed"
        try:
            tester.call(SERVER, "POST", "/api/join", KEY, {"url": PAGE})
        except tester.ApiError as exc:
            busy = "rejected" if "409" in str(exc) else f"other: {exc}"
        check("a second concurrent join is refused (max_sessions=1)", busy, "rejected")

        print("\n5. Following the transcript incrementally")
        since, collected, records, deadline = 0, [], [], time.time() + 90
        state = "starting"
        while time.time() < deadline:
            data = tester.call(SERVER, "GET",
                               f"/api/sessions/{sid}/transcript?since={since}", KEY)
            for line in data["lines"]:
                print(f"      [{line['speaker']}] {line['text']}")
                collected.append(f"{line['speaker']}: {line['text']}")
                records.append(line)
            check_since = data["next"] >= since
            if not check_since:
                FAILURES.append("since cursor went backwards")
            since = data["next"]
            state = data["state"]
            if state in ("ended", "failed"):
                break
            time.sleep(1.5)

        check("session finished", state, "ended")
        # The API returns clean text plus a continuation flag; the "..." marker
        # is a rendering convention, so consumers can stitch or display freely.
        check("transcript came through the API", collected, [
            "Alice Chen: So I think we should ship it",
            "Alice Chen: on Friday",
            "Bob Ortiz: Agreed, let's do it",
        ])
        check("continuation flags mark the mid-sentence line",
              [r["continuation"] for r in records], [False, True, False])
        check("each record carries a console-ready 'line' field",
              records[1]["line"].endswith("Alice Chen: ...on Friday"), True)

        print("\n6. Persistence and cleanup")
        jsonl = ROOT / "data" / "test-data" / "transcripts" / f"{sid}.jsonl"
        check("transcript persisted to disk", jsonl.exists(), True)
        if jsonl.exists():
            records = [json.loads(l) for l in jsonl.read_text(encoding="utf-8").splitlines() if l.strip()]
            check("persisted line count", len(records), 3)

        deleted = tester.call(SERVER, "DELETE", f"/api/sessions/{sid}", KEY)
        check("finished session can be deleted", deleted, {"deleted": sid})
        after = tester.call(SERVER, "GET", "/api/sessions", KEY)
        check("session list is empty again", after, {"sessions": []})

    finally:
        proc.terminate()
        try:
            out, _ = proc.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
        if FAILURES:
            print("\n--- server log ---")
            print(out[-3000:])

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S): " + ", ".join(FAILURES))
        return 1
    print("ALL CHECKS PASSED")
    return 0


raise SystemExit(main())
