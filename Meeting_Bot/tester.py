#!/usr/bin/env python3
"""
tester.py -- command line client for the meet-listener container.

Talks to the API server over HTTP, so it works whether the container runs on
this machine, another host, or in a cluster. Uses only the standard library.

    python tester.py health
    python tester.py join https://meet.google.com/abc-defg-hij
    python tester.py list
    python tester.py watch <session_id>          # live transcript, follows along
    python tester.py transcript <session_id>     # everything captured so far
    python tester.py leave <session_id>
    python tester.py rm <session_id>

Point it elsewhere with --server, or the MEET_SERVER environment variable.
Authenticate with --key or MEET_API_KEY when the server requires it.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

for _stream in (sys.stdout, sys.stderr):
    # Captions can be in any script; a legacy console codepage would raise
    # UnicodeEncodeError on the first non-Latin character.
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DEFAULT_SERVER = os.environ.get("MEET_SERVER", "http://localhost:8080")
DEFAULT_KEY = os.environ.get("MEET_API_KEY", "")


class ApiError(Exception):
    pass


def render(line: Dict[str, Any]) -> str:
    """Console form of a transcript record.

    The API keeps `text` clean and flags mid-sentence continuations separately;
    the leading "..." is added here so the printed view matches the bot's own
    console output.
    """
    marker = "..." if line.get("continuation") else ""
    return f"[{line['ts']}] {line['speaker']}: {marker}{line['text']}"


def call(server: str, method: str, path: str, key: str = "",
         body: Optional[Dict[str, Any]] = None, timeout: float = 30) -> Dict[str, Any]:
    url = server.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    if key:
        request.add_header("X-API-Key", key)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode() or "{}"
        try:
            return json.loads(raw)
        except ValueError:
            raise ApiError(
                f"{server} replied with something that is not JSON: {raw[:200]!r}"
            ) from None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except Exception:
            pass
        raise ApiError(f"HTTP {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise ApiError(
            f"cannot reach {server} ({exc.reason}). Is the container running?"
        ) from None
    # A port that accepts the connection and then drops it is NOT a URLError:
    # http.client raises RemoteDisconnected/BadStatusLine, which used to escape
    # as a raw traceback. This is what a container whose server never started
    # looks like from the outside, so name that possibility explicitly.
    except http.client.HTTPException as exc:
        raise ApiError(
            f"{server} accepted the connection then failed to answer "
            f"({type(exc).__name__}). Something is listening on that port but it "
            f"is not the meet-listener API -- check `docker compose logs`."
        ) from None
    except (TimeoutError, ConnectionError, OSError) as exc:
        raise ApiError(f"network error talking to {server}: "
                       f"{type(exc).__name__}: {exc}") from None


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #

def cmd_health(args) -> int:
    info = call(args.server, "GET", "/api/health", args.key)
    print(f"server      : {args.server}")
    print(f"credentials : {'present' if info['credentials_present'] else 'MISSING'}"
          f"  ({info['profile_dir']})")
    print(f"sessions    : {info['active_sessions']} active / {info['max_sessions']} max")
    print(f"auth        : {'required' if info['auth_required'] else 'open'}")
    if not info["credentials_present"]:
        print("\nNo Google session in the mounted profile. Run "
              "`python meet_listener.py --login` on a machine with a screen,\n"
              "then mount that directory into the container.")
        return 1
    return 0


def cmd_join(args) -> int:
    body: Dict[str, Any] = {"url": args.url, "name": args.name}
    if args.guest:
        body["guest"] = True
    if args.max_minutes:
        body["max_minutes"] = args.max_minutes
    if args.alone_grace is not None:
        body["alone_grace"] = args.alone_grace
    session = call(args.server, "POST", "/api/join", args.key, body)
    print(f"session {session['session_id']} -> {session['state']}")
    print(f"  {session['url']}")
    print(f"\nfollow it with:  python tester.py watch {session['session_id']}")
    if args.watch:
        args.session_id = session["session_id"]
        return cmd_watch(args)
    return 0


def cmd_list(args) -> int:
    sessions = call(args.server, "GET", "/api/sessions", args.key)["sessions"]
    if not sessions:
        print("no sessions")
        return 0
    print(f"{'SESSION':<14} {'STATE':<11} {'LINES':>6}  URL")
    for s in sessions:
        print(f"{s['session_id']:<14} {s['state']:<11} {s['line_count']:>6}  {s['url']}")
        if s.get("error"):
            print(f"{'':<14} error: {s['error']}")
    return 0


def cmd_transcript(args) -> int:
    data = call(args.server, "GET",
                f"/api/sessions/{args.session_id}/transcript", args.key)
    for line in data["lines"]:
        print(render(line))
    print(f"\n-- {data['line_count']} line(s), state={data['state']}", file=sys.stderr)
    return 0


def cmd_watch(args) -> int:
    """Poll incrementally and print only what is new -- the streaming view."""
    since = 0
    print(f"watching {args.session_id} (Ctrl+C to stop)\n", file=sys.stderr)
    try:
        while True:
            data = call(args.server, "GET",
                        f"/api/sessions/{args.session_id}/transcript?since={since}",
                        args.key)
            for line in data["lines"]:
                print(render(line), flush=True)
            since = data["next"]
            if data["state"] in ("ended", "failed"):
                print(f"\n-- session {data['state']}"
                      f"{': ' + data['error'] if data.get('error') else ''}"
                      f" ({since} line(s))", file=sys.stderr)
                return 1 if data["state"] == "failed" else 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n-- stopped watching (the bot is still in the call)", file=sys.stderr)
        return 130


def cmd_leave(args) -> int:
    result = call(args.server, "POST",
                  f"/api/sessions/{args.session_id}/leave", args.key)
    print("leaving" if result["stopping"] else "already finished")
    return 0


def cmd_rm(args) -> int:
    call(args.server, "DELETE", f"/api/sessions/{args.session_id}", args.key)
    print(f"deleted {args.session_id}")
    return 0


def _connection_args(with_defaults: bool) -> argparse.ArgumentParser:
    """--server/--key, shared by the top level and every subcommand.

    Defined in both places so they work before OR after the subcommand:
    `tester.py --key K join URL` and `tester.py join URL --key K` are equally
    valid, because an argument that only exists on the top-level parser is a
    usage error once a subcommand has been seen.

    The subcommand copies use SUPPRESS, so an omitted flag leaves whatever the
    top-level parser already stored instead of overwriting it with a default.
    """
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--server",
        default=DEFAULT_SERVER if with_defaults else argparse.SUPPRESS,
        help="Base URL of the container.")
    parser.add_argument(
        "--key",
        default=DEFAULT_KEY if with_defaults else argparse.SUPPRESS,
        help="X-API-Key, when required.")
    return parser


def build_parser() -> argparse.ArgumentParser:
    shared = _connection_args(with_defaults=False)
    parser = argparse.ArgumentParser(
        description="Client for the meet-listener container.",
        parents=[_connection_args(with_defaults=True)],
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("health", parents=[shared],
                   help="Check the server and its credentials.").set_defaults(fn=cmd_health)

    join = sub.add_parser("join", parents=[shared], help="Send a bot into a meeting.")
    join.add_argument("url")
    join.add_argument("--name", default="",
                      help="Guest display name. Ignored unless --guest is set: a "
                           "signed-in join uses the Google account's own name.")
    join.add_argument("--guest", action="store_true",
                      help="Join anonymously. The server refuses this unless it "
                           "was started with MEET_REQUIRE_LOGIN=0.")
    join.add_argument("--max-minutes", type=float, default=0)
    join.add_argument("--alone-grace", type=float, default=None,
                      help="Seconds alone before leaving. 0 disables.")
    join.add_argument("--watch", action="store_true", help="Follow the transcript after joining.")
    join.add_argument("--interval", type=float, default=2.0)
    join.set_defaults(fn=cmd_join)

    sub.add_parser("list", parents=[shared],
                   help="List sessions.").set_defaults(fn=cmd_list)

    for name, fn, helptext in (
        ("transcript", cmd_transcript, "Print everything captured so far."),
        ("leave", cmd_leave, "Make the bot hang up."),
        ("rm", cmd_rm, "Forget a finished session."),
    ):
        p = sub.add_parser(name, parents=[shared], help=helptext)
        p.add_argument("session_id")
        p.set_defaults(fn=fn)

    watch = sub.add_parser("watch", parents=[shared],
                           help="Follow a transcript live.")
    watch.add_argument("session_id")
    watch.add_argument("--interval", type=float, default=2.0)
    watch.set_defaults(fn=cmd_watch)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.fn(args)
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
