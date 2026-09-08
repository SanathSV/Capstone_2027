#!/usr/bin/env python3
"""Produce `auth.json` — a portable Google session for the Astra meeting bot.

Why this script exists
----------------------
The bot joins Google Meet as a real, signed-in account. Meet treats anonymous
guests differently: they wait in the lobby, they cannot always turn captions on,
and some organisations refuse them outright. So the bot needs credentials.

It cannot have a password. Google will not let an automated browser through the
sign-in flow (2FA, device checks, "this browser may not be secure"), and putting
a password in a container image is not a thing we are going to do. Instead a
human signs in **once**, on a machine with a screen, and this script exports the
resulting session as a JSON file the container can mount.

Why JSON and not a Chrome profile
---------------------------------
A Chrome profile directory is not portable. Cookie values are AES-GCM encrypted
under a master key that Windows wraps with DPAPI and macOS keeps in the Keychain,
so Linux Chrome inside a container simply cannot read a profile created on a
Windows laptop — the account silently looks signed out. Playwright reads cookies
already decrypted over CDP, so `context.storage_state()` gives a credentials file
that works on any operating system. This is the same reason
`Meeting_Bot/meet_listener.py` exports `storage_state.json` alongside its
profile; this script is that step, standalone and with the output named
`auth.json` as the deployment pipeline expects.

Usage
-----
    python generate_google_auth.py                  # sign in, write ./secrets/auth.json
    python generate_google_auth.py --out /path/auth.json
    python generate_google_auth.py --check          # is the existing file still valid?
    python generate_google_auth.py --verify         # re-open it in a clean browser

First run:

    pip install -r requirements.txt
    python -m playwright install chromium

Security
--------
`auth.json` is a live Google session. Anyone holding it is signed in as the bot
account, no password and no second factor required. Treat it exactly like a
password: it is gitignored, written with owner-only permissions where the OS
supports them, and it should reach the container through a secret store
(Kubernetes Secret, Docker secret) rather than being baked into an image.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import stat
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from playwright.async_api import BrowserContext, async_playwright
    from playwright.async_api import Error as PlaywrightError
except ImportError:  # pragma: no cover - the message is the whole point
    print(
        "Playwright is not installed.\n"
        "    pip install -r requirements.txt\n"
        "    python -m playwright install chromium",
        file=sys.stderr,
    )
    raise SystemExit(2)


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

# Everything this script produces lives here, next to the script rather than in
# the Next.js tree, so a stray `next build` can never sweep it into a bundle.
DEFAULT_DIR = Path(__file__).resolve().parent / "secrets"
DEFAULT_OUT = DEFAULT_DIR / "auth.json"
# A persistent Chrome profile makes the *interactive* sign-in survive a retry:
# if the export fails you are not asked to complete 2FA a second time.
DEFAULT_PROFILE = DEFAULT_DIR / "profile"

# The cookies that actually constitute a signed-in Google session. Checking for
# "any google.com cookie" is not enough — NID and _ga are set for signed-out
# visitors too, so a logged-out profile would report itself as authenticated.
GOOGLE_AUTH_COOKIES = frozenset(
    {
        "SID",
        "HSID",
        "SSID",
        "APISID",
        "SAPISID",
        "LSID",
        "__Secure-1PSID",
        "__Secure-3PSID",
        "__Secure-1PSIDTS",
    }
)

# The subset whose presence alone proves a real login.
SESSION_COOKIES = frozenset({"SID", "__Secure-1PSID", "__Secure-3PSID"})

CHROMIUM_ARGS: List[str] = [
    # Stops Chromium advertising itself through the Blink automation feature
    # flag. Google's sign-in flow is markedly less cooperative without this.
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-notifications",
    "--start-maximized",
    "--window-size=1280,900",
]

IGNORED_DEFAULT_ARGS: List[str] = ["--enable-automation"]

# Mirrors Meeting_Bot/meet_listener.py so both halves of the system describe a
# failure the same way.
EXIT_OK = 0
EXIT_NO_SESSION = 4
EXIT_PROFILE_LOCKED = 6
EXIT_INTERRUPTED = 130


def log(message: str) -> None:
    print(f"[auth] {message}", flush=True)


def _force_utf8_output() -> None:
    """Windows consoles default to cp1252 and choke on the box-drawing output."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Inspecting a saved auth.json
# --------------------------------------------------------------------------- #


def describe_auth_file(path: Path) -> Optional[Dict[str, Any]]:
    """Summarise an existing auth.json without opening a browser.

    Returns None when the file is missing or unreadable. The summary carries the
    account (when Playwright captured one), the number of Google auth cookies,
    and the soonest expiry — which is the field that decides when this has to be
    done again.
    """
    if not path.exists():
        return None

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"{path} exists but could not be read: {exc}")
        return None

    cookies = data.get("cookies", [])
    google = [c for c in cookies if "google" in str(c.get("domain", ""))]
    auth = [c for c in google if c.get("name") in GOOGLE_AUTH_COOKIES]
    session = [c for c in google if c.get("name") in SESSION_COOKIES]

    # Session cookies carry expires = -1; ignore those when finding the horizon.
    expiries = [
        c["expires"]
        for c in auth
        if isinstance(c.get("expires"), (int, float)) and c["expires"] > 0
    ]
    soonest = min(expiries) if expiries else None

    return {
        "path": str(path),
        "cookies_total": len(cookies),
        "cookies_google": len(google),
        "cookies_auth": len(auth),
        "signed_in": bool(session),
        "expires_at": (
            datetime.fromtimestamp(soonest, tz=timezone.utc).isoformat()
            if soonest
            else None
        ),
        "bytes": path.stat().st_size,
    }


def print_summary(summary: Dict[str, Any]) -> None:
    log(f"file           {summary['path']}  ({summary['bytes']} bytes)")
    log(f"google cookies {summary['cookies_google']} "
        f"({summary['cookies_auth']} of them authentication cookies)")
    log(f"signed in      {'yes' if summary['signed_in'] else 'NO'}")
    if summary["expires_at"]:
        log(f"earliest expiry {summary['expires_at']}")


# --------------------------------------------------------------------------- #
# Browser plumbing
# --------------------------------------------------------------------------- #


async def has_google_session(context: BrowserContext) -> bool:
    """True once Google has dropped a signed-in session cookie on this context."""
    try:
        cookies = await context.cookies("https://accounts.google.com")
    except PlaywrightError:
        return False
    return bool({c.get("name") for c in cookies} & SESSION_COOKIES)


async def detect_account(context: BrowserContext) -> Optional[str]:
    """Best-effort read of which account is signed in.

    Purely informational — it is easy to complete this flow on the wrong Google
    account, and finding that out here beats finding it out when the bot joins a
    meeting under someone's personal address.
    """
    page = None
    try:
        page = await context.new_page()
        await page.goto(
            "https://myaccount.google.com/",
            wait_until="domcontentloaded",
            timeout=30_000,
        )
        await page.wait_for_timeout(2000)
        content = await page.content()
        import re

        match = re.search(r"[\w.+-]+@[\w.-]+\.\w+", content)
        return match.group(0) if match else None
    except Exception:
        return None
    finally:
        if page is not None:
            try:
                await page.close()
            except Exception:
                pass


def harden_permissions(path: Path) -> None:
    """Owner-only permissions where the OS has them.

    On POSIX this is chmod 600. On Windows the file inherits the user profile's
    ACL, which is already user-scoped, so there is nothing useful to tighten —
    say so rather than pretending the call did something.
    """
    if os.name == "nt":
        log("note: on Windows the file inherits your user profile's ACL. "
            "Keep it out of any synced or shared folder.")
        return
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        log(f"permissions set to 600 on {path}")
    except OSError as exc:
        log(f"could not tighten permissions on {path}: {exc}")


async def export_auth(context: BrowserContext, out_path: Path) -> bool:
    """Write the context's cookies and localStorage to `out_path`."""
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Write to a temporary file and move it into place: a half-written auth.json
    # is worse than none, because the container would mount it and fail
    # mysteriously rather than obviously.
    temp_path = out_path.with_suffix(".tmp")
    try:
        await context.storage_state(path=str(temp_path))
    except Exception as exc:
        log(f"could not export the session: {type(exc).__name__}: {exc}")
        temp_path.unlink(missing_ok=True)
        return False

    temp_path.replace(out_path)
    harden_permissions(out_path)

    summary = describe_auth_file(out_path)
    if not summary or not summary["signed_in"]:
        log("the exported file does not contain a Google session.")
        return False

    print_summary(summary)
    return True


async def wait_for_signin(context: BrowserContext, timeout: float) -> bool:
    """Hold the browser open until the human is done.

    Three independent finish signals, because we cannot assume an interactive
    terminal: `isatty()` lies when the script is launched by another tool, so a
    bare `input()` would raise EOFError instead of waiting.

      1. The session cookie appears (the usual, no keypress needed).
      2. Enter is pressed in this terminal.
      3. The browser window is closed.
    """
    loop = asyncio.get_running_loop()

    enter = asyncio.Event()

    def wait_for_enter() -> None:
        try:
            line = sys.stdin.readline()
        except Exception:
            return
        if line != "":  # "" means EOF (no real terminal), not a keypress
            loop.call_soon_threadsafe(enter.set)

    # Daemon thread: if nobody ever presses Enter it dies with the process
    # rather than holding up interpreter shutdown.
    threading.Thread(target=wait_for_enter, daemon=True).start()

    closed = asyncio.Event()
    context.on("close", lambda *_: loop.call_soon_threadsafe(closed.set))

    deadline = time.time() + timeout
    while time.time() < deadline:
        if enter.is_set() or closed.is_set():
            break
        if await has_google_session(context):
            log("Google session detected.")
            # Give Chrome a moment to flush every cookie of the flow to disk;
            # exporting the instant SID appears can miss __Secure-1PSIDTS.
            await asyncio.sleep(3)
            break
        await asyncio.sleep(2)
    else:
        log("timed out waiting for sign-in.")

    # Enter or a closed window can fire without a real login, so confirm before
    # claiming success — reporting a session that does not exist would send the
    # bot into its next meeting as an anonymous guest.
    return await has_google_session(context)


# --------------------------------------------------------------------------- #
# Modes
# --------------------------------------------------------------------------- #


async def run_login(args: argparse.Namespace) -> int:
    out_path = Path(args.out).expanduser().resolve()
    profile_dir = Path(args.profile).expanduser().resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)

    existing = describe_auth_file(out_path)
    if existing and existing["signed_in"] and not args.force:
        log(f"{out_path} already holds a valid Google session.")
        print_summary(existing)
        log("Re-run with --force to replace it, or --verify to test it.")
        return EXIT_OK

    async with async_playwright() as pw:
        opts: Dict[str, Any] = dict(
            headless=False,  # the whole point: a human signs in here
            args=CHROMIUM_ARGS,
            ignore_default_args=IGNORED_DEFAULT_ARGS,
            user_data_dir=str(profile_dir),
            locale="en-US",
            no_viewport=True,
        )
        if args.channel:
            opts["channel"] = args.channel

        try:
            context = await pw.chromium.launch_persistent_context(**opts)
        except PlaywrightError as exc:
            if args.channel:
                log(f"channel {args.channel!r} unavailable ({exc}); "
                    "falling back to the bundled Chromium.")
                opts.pop("channel")
                try:
                    context = await pw.chromium.launch_persistent_context(**opts)
                except PlaywrightError as inner:
                    log(f"could not start a browser: {inner}")
                    return EXIT_PROFILE_LOCKED
            else:
                # Chrome allows exactly one browser per user-data directory.
                log(f"could not start a browser: {exc}")
                log(f"If {profile_dir} is open in another window, close it and retry.")
                return EXIT_PROFILE_LOCKED

        try:
            context.set_default_timeout(30_000)
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto("https://accounts.google.com/", wait_until="domcontentloaded")

            print()
            print("  ┌──────────────────────────────────────────────────────────┐")
            print("  │  Sign in to the DEDICATED BOT Google account.            │")
            print("  │                                                          │")
            print("  │  Not your personal account — whoever signs in here is    │")
            print("  │  who shows up in the participant list of every meeting.  │")
            print("  │                                                          │")
            print("  │  Then press Enter here, or just close the window.        │")
            print("  └──────────────────────────────────────────────────────────┘")
            print()

            signed_in = await wait_for_signin(context, args.timeout)

            if not signed_in:
                log("no Google session was established.")
                log("Re-run this script and complete the sign-in.")
                return EXIT_NO_SESSION

            account = await detect_account(context)
            if account:
                log(f"signed in as {account}")

            if not await export_auth(context, out_path):
                return EXIT_NO_SESSION

        finally:
            try:
                await context.close()
            # Closing the last page of a persistent context exits Chrome, which
            # drops the driver connection; close() then raises a plain Exception
            # rather than a PlaywrightError. The file is already written.
            except Exception:
                pass

    print_next_steps(out_path)
    return EXIT_OK


async def run_verify(args: argparse.Namespace) -> int:
    """Prove the file works by loading it into a browser that has nothing else.

    This is the honest test. Checking cookies in the JSON only proves the file
    *looks* right; a fresh incognito browser seeded with nothing but this file is
    exactly what the container does.
    """
    out_path = Path(args.out).expanduser().resolve()
    summary = describe_auth_file(out_path)
    if not summary:
        log(f"no credentials file at {out_path}. Run this script without --verify first.")
        return EXIT_NO_SESSION

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=args.headless,
            args=CHROMIUM_ARGS,
            ignore_default_args=IGNORED_DEFAULT_ARGS,
        )
        context = await browser.new_context(storage_state=str(out_path), locale="en-US")
        try:
            ok = await has_google_session(context)
            account = await detect_account(context) if ok else None
            if ok:
                log(f"VALID — a clean browser is signed in{f' as {account}' if account else ''}.")
                print_summary(summary)
                return EXIT_OK
            log("INVALID — a clean browser seeded with this file is signed out.")
            log("The session was revoked or has expired. Re-run without --verify.")
            return EXIT_NO_SESSION
        finally:
            await context.close()
            await browser.close()


def run_check(args: argparse.Namespace) -> int:
    """Offline check: no browser, just read the file. Cheap enough for CI."""
    out_path = Path(args.out).expanduser().resolve()
    summary = describe_auth_file(out_path)
    if not summary:
        log(f"no credentials file at {out_path}.")
        return EXIT_NO_SESSION
    print_summary(summary)
    if not summary["signed_in"]:
        log("this file carries no Google session.")
        return EXIT_NO_SESSION
    return EXIT_OK


def print_next_steps(out_path: Path) -> None:
    print()
    log("Done. The bot container can now join meetings pre-authenticated.")
    print()
    print("  Mount it into the bot at run time — never bake it into an image:")
    print()
    print(f"    docker run -v {out_path}:/creds/auth.json:ro astra-meeting-bot")
    print()
    print("  Or as a Kubernetes secret, alongside the pre-context payload:")
    print()
    print(f"    kubectl create secret generic astra-bot-auth \\")
    print(f"      --from-file=auth.json={out_path}")
    print()
    print("  Check it later without signing in again:")
    print()
    print("    python generate_google_auth.py --check     # read the file")
    print("    python generate_google_auth.py --verify    # open it in a browser")
    print()


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create auth.json — a portable Google session for the Astra meeting bot.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "The file it writes is a live Google session. Keep it out of git and "
            "out of container images; mount it at run time instead."
        ),
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help=f"where to write the credentials (default: {DEFAULT_OUT})",
    )
    parser.add_argument(
        "--profile",
        default=str(DEFAULT_PROFILE),
        help="Chrome user-data directory used during sign-in "
             f"(default: {DEFAULT_PROFILE}). Lets a retry skip 2FA.",
    )
    parser.add_argument(
        "--channel",
        default=os.environ.get("ASTRA_BROWSER_CHANNEL", "chrome"),
        help="browser channel: chrome, msedge, or empty for bundled Chromium",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=900.0,
        help="seconds to wait for the sign-in to finish (default: 900)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an existing valid auth.json instead of keeping it",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="load the existing file in a clean browser and report whether it works",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="inspect the existing file offline, without opening a browser",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="only meaningful with --verify; sign-in itself is always headful",
    )
    return parser.parse_args()


def main() -> int:
    _force_utf8_output()
    args = parse_args()

    if args.check:
        return run_check(args)

    # Playwright's subprocess transport needs the Proactor loop on Windows.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    try:
        if args.verify:
            return asyncio.run(run_verify(args))
        return asyncio.run(run_login(args))
    except KeyboardInterrupt:
        log("interrupted.")
        return EXIT_INTERRUPTED


if __name__ == "__main__":
    raise SystemExit(main())
