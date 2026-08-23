#!/usr/bin/env python3
"""
meet_listener.py -- Join a Google Meet with Playwright and stream its live captions.

The script keeps a *persistent* Chromium profile so you sign in to Google exactly
once (by hand); every later run reuses those cookies and looks like a normal
returning browser session instead of a fresh automated one.

Quick start
-----------
    pip install playwright
    playwright install chromium

    # 1) one-time interactive sign-in (a browser opens; log in, then press Enter)
    python meet_listener.py --login

    # 2) join a meeting and print captions
    python meet_listener.py --url https://meet.google.com/abc-defg-hij

Captions go to stdout, diagnostics go to stderr, so you can do:

    python meet_listener.py --url ... > transcript.txt

Press Ctrl+C to leave the call cleanly and flush the last caption line.

Note: recording or transcribing a meeting is subject to the consent rules of the
people in the room -- announce the bot before you use it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import sqlite3
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from playwright.async_api import BrowserContext, Page
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

def _force_utf8_output() -> None:
    """Make stdout/stderr accept any script, not just the console codepage.

    Windows consoles default to a legacy codepage (cp1252 here), which raises
    UnicodeEncodeError on the first Telugu, Hindi or CJK caption. Captions are
    whatever people speak, so the streams must be UTF-8 or transcription dies
    on its first non-Latin word.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


_force_utf8_output()


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

# The meeting to join. Override with --url or the MEET_URL environment variable.
MEET_URL: str = os.environ.get("MEET_URL", "https://meet.google.com/abc-defg-hij")

# Dedicated profile directory: this is what keeps you logged in between runs.
# Defaults to ./creds so the host and the container use the SAME credentials:
# docker-compose mounts this directory at /creds inside the container, which is
# what makes the containerised browser behave like the one on your machine.
USER_DATA_DIR: Path = Path(os.environ.get("MEET_PROFILE_DIR", "creds"))

# ONLY used for an explicit --allow-guest join. A signed-in join carries the
# Google account's own name, which is the point of using credentials at all.
DISPLAY_NAME: str = os.environ.get("MEET_DISPLAY_NAME", "Meeting Notetaker")

# Meet prints "Joining as you@example.com" in the green room when signed in.
ACCOUNT_RE = re.compile(r"joining as\s*([\w.+-]+@[\w.-]+)", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")

# Portable credentials. A Chrome profile is NOT portable across operating
# systems: cookie values are AES-GCM encrypted under a master key that Windows
# wraps with DPAPI, so Linux Chrome inside a container cannot read a profile
# created on Windows and the account simply looks signed out. Playwright reads
# cookies already decrypted over CDP, so exporting them to JSON gives a
# credentials file that works anywhere.
STORAGE_STATE_NAME = "storage_state.json"

# When set, failures drop a screenshot here. Inside a container there is no
# window to look at, so a picture is the only way to see what Meet rendered.
DEBUG_DIR: str = os.environ.get("MEET_DEBUG_DIR", "")

# The cookies that actually constitute a signed-in Google session. Checking for
# "any google.com cookie" is not enough: NID and _ga are set for signed-out
# visitors too, so a logged-out profile would report itself as authenticated.
GOOGLE_AUTH_COOKIES = (
    "SID", "HSID", "SSID", "APISID", "SAPISID", "LSID",
    "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS",
)

CHROMIUM_ARGS: List[str] = [
    # The single most important anti-detection flag: stops Chromium from
    # advertising itself through the Blink automation feature flag.
    "--disable-blink-features=AutomationControlled",
    # Auto-accept the getUserMedia permission prompt instead of showing the
    # native "Allow microphone?" bubble, which Playwright cannot click.
    "--use-fake-ui-for-media-stream",
    # Feed silent audio / a blank video track so the join flow succeeds even on a
    # machine with no real microphone or webcam attached.
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-notifications",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--start-maximized",
    # Xvfb has no window manager, so --start-maximized does nothing there and
    # Chrome falls back to a small default window. Meet then collapses its
    # toolbar and the captions control disappears into the overflow menu.
    "--window-size=1920,1080",
    "--window-position=0,0",
]

# Chromium flags Playwright adds by default that give the automation away.
IGNORED_DEFAULT_ARGS: List[str] = ["--enable-automation"]

# Overlays Meet likes to throw at you before/after joining.
DISMISS_LABELS = [
    "Got it",
    "Dismiss",
    "Continue without microphone and camera",
    "Continue without microphone",
    "Continue without camera",
    "Use without a microphone",
    "No thanks",
    "Close",
    "OK",
]

# Every wording Meet uses for "you are waiting to be let in". The lobby has a
# hang-up button of its own, so text is the only reliable way to tell it apart
# from the real in-call UI.
LOBBY_RE = re.compile(
    r"asking to be let in|waiting for the host|someone will let you in|"
    r"please wait until a meeting host|you'll join the call when|"
    r"waiting for someone to let you in|you can join when someone lets you in",
    re.I,
)

JOIN_BUTTON_RE = re.compile(r"^\s*(join now|ask to join|join anyway|switch here)\s*$", re.I)
LEAVE_BUTTON_SELECTOR = 'button[aria-label*="Leave call" i], button[aria-label*="Hang up" i]'
MIC_BUTTON_SELECTOR = (
    'button[aria-label*="microphone" i], div[role="button"][aria-label*="microphone" i]'
)
CAM_BUTTON_SELECTOR = 'button[aria-label*="camera" i], div[role="button"][aria-label*="camera" i]'
CAPTION_BUTTON_SELECTOR = (
    'button[aria-label*="caption" i], div[role="button"][aria-label*="caption" i]'
)
# Only an explicit on/off label identifies the real CC toggle. Plain "caption"
# also matches "Captions settings" and the language picker, which do nothing.
CAPTION_LABEL_RE = re.compile(r"\bturn\s+(on|off)\b.*\b(captions?|subtitles?)\b", re.I)

# Caption watchdog tuning. Enabling captions once at join is not enough: the CC
# control can be re-rendered or switched off mid-call, so the state is
# re-asserted this often for as long as no caption text has arrived. The status
# line makes a silent room distinguishable from a broken scraper.
CC_RETRY_SECONDS = 15.0
STATUS_SECONDS = 60.0

# Shared vocabulary for failures, so the CLI's exit code and the API server's
# error string always describe a problem the same way.
EXIT_REASONS: Dict[int, str] = {
    0: "finished cleanly",
    1: "no meeting URL was given",
    2: "never found a Join button (bad link, or the meeting has not started)",
    3: "never got into the call (not admitted, or the meeting ended)",
    4: "--login finished without establishing a Google session",
    5: "the profile is not signed in and a guest join was not allowed",
    6: "the credentials profile is already open in another browser",
    130: "interrupted",
}

# Injected into the page: watches the caption region and pushes every changed
# caption block back to Python through the exposed binding. The page only ever
# sends *snapshots*; all of the de-duplication logic lives in CaptionSink below.
CAPTION_OBSERVER_JS = r"""
(() => {
  if (window.__meetCapInstalled) return "already-installed";
  window.__meetCapInstalled = true;

  // Google rotates these class names, so every lookup is a prioritized list
  // that degrades to a structural heuristic if nothing matches.
  const ROOT_SELECTORS = [
    'div[jsname="dsyhDe"]',
    'div.a4cQT',
    'div[role="region"][aria-label*="aption" i]',
    'div[aria-label*="aption" i][aria-live]',
  ];
  const TEXT_SELECTORS = [
    'div[jsname="tgaKEf"]',
    'div.iTTPOb',
    'div.bh44bd',
    'div.VbkSUe',
  ];
  const NAME_SELECTORS = [
    'div.zs7s8d',
    'div.KcIKyf',
    'span.NWpY1d',
    'div.jxFHg',
  ];

  let seq = 0;

  const findRoot = () => {
    for (const sel of ROOT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  const textNodesIn = (root) => {
    for (const sel of TEXT_SELECTORS) {
      const found = root.querySelectorAll(sel);
      if (found.length) return Array.from(found);
    }
    // Structural fallback: leaf elements inside the caption region that
    // actually carry text.
    return Array.from(root.querySelectorAll('div, span')).filter(
      (el) => el.childElementCount === 0 && (el.textContent || '').trim().length > 0
    );
  };

  const speakerFor = (textEl, root) => {
    let block = textEl.parentElement;
    for (let hop = 0; hop < 4 && block && block !== root; hop++) {
      for (const sel of NAME_SELECTORS) {
        const n = block.querySelector(sel);
        const v = n && (n.textContent || '').trim();
        if (v && !textEl.contains(n)) return v;
      }
      // Meet renders an avatar next to the name; its alt text is the speaker.
      const img = block.querySelector('img[alt]');
      const alt = img && (img.getAttribute('alt') || '').trim();
      if (alt) return alt;
      block = block.parentElement;
    }
    return 'Unknown';
  };

  const emit = () => {
    const root = findRoot();
    if (!root) return;
    window.__meetCapRootSeen = true;   // diagnostic for the Python watchdog
    for (const el of textNodesIn(root)) {
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (!el.dataset.meetCapId) el.dataset.meetCapId = String(++seq);
      if (el.__meetLastText === text) continue;   // nothing new in this block
      el.__meetLastText = text;
      try {
        window.__meetCaption(JSON.stringify({
          id: el.dataset.meetCapId,
          speaker: speakerFor(el, root),
          text: text,
          ts: Date.now(),
        }));
      } catch (e) { /* binding torn down during navigation */ }
    }
  };

  // Debounce: Meet mutates the DOM constantly, we only need ~8 scans a second.
  let pending = null;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; emit(); }, 120);
  };

  const install = () => {
    window.__meetCapObserver = new MutationObserver(schedule);
    window.__meetCapObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
    // Safety net in case a mutation batch is missed (re-renders, throttling).
    window.__meetCapPoll = setInterval(emit, 500);
    emit();
  };

  if (document.body) {
    install();
  } else {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  }
  return "installed";
})()
"""

STEALTH_JS = r"""
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
"""


def log(message: str) -> None:
    """Diagnostics go to stderr so stdout stays a clean transcript."""
    print(f"[{datetime.now():%H:%M:%S}] {message}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# Caption aggregation
# --------------------------------------------------------------------------- #


@dataclass
class _Utterance:
    speaker: str
    text: str
    updated: float
    emitted: str = ""  # the part of `text` that has already been written out


class CaptionSink:
    """Turns growing caption snapshots into printed, non-duplicated lines.

    Google Meet mutates a caption block in place while somebody is talking:
    "So I" -> "So I think" -> "So I think we should". Printing every snapshot
    would spam the console, so a block is held until it has been quiet for
    ``stable_after`` seconds and then written once. If the same block keeps
    growing afterwards, only the new suffix is printed (marked with an ellipsis).
    """

    def __init__(
        self,
        transcript_path: Optional[Path] = None,
        jsonl_path: Optional[Path] = None,
        stable_after: float = 1.5,
        max_age: float = 300.0,
        on_line: Optional[Callable[[Dict[str, Any]], None]] = None,
        echo: bool = True,
    ) -> None:
        self.transcript_path = transcript_path
        self.jsonl_path = jsonl_path
        self.stable_after = stable_after
        self.max_age = max_age
        # on_line lets an embedder (the API server) receive each finished line
        # as a record without having to parse stdout.
        self.on_line = on_line
        self.echo = echo
        self._lines: Dict[str, _Utterance] = {}
        self._lock = asyncio.Lock()
        self.count = 0

        for path in (transcript_path, jsonl_path):
            if path and path.parent:
                path.parent.mkdir(parents=True, exist_ok=True)

    # -- called from the page binding ---------------------------------------
    async def on_caption(self, _source: Any, payload: str) -> None:
        try:
            data = json.loads(payload)
        except (TypeError, ValueError):
            return
        key = str(data.get("id") or "")
        text = (data.get("text") or "").strip()
        speaker = (data.get("speaker") or "").strip() or "Unknown"
        if not key or not text:
            return

        async with self._lock:
            entry = self._lines.get(key)
            if entry is None:
                self._lines[key] = _Utterance(speaker=speaker, text=text, updated=time.time())
                return
            # Meet recycles caption rows. A snapshot that no longer extends the
            # previous one is a brand new utterance, so flush whatever is still
            # pending on this row before overwriting it -- otherwise a fast
            # speaker change would drop the earlier sentence entirely.
            if not text.startswith(entry.text):
                self._flush(key, entry)
                entry.emitted = ""
            entry.speaker = speaker
            entry.text = text
            entry.updated = time.time()

    # -- background flusher --------------------------------------------------
    async def janitor(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await asyncio.sleep(0.4)
            now = time.time()
            async with self._lock:
                for key, entry in list(self._lines.items()):
                    if entry.text != entry.emitted and now - entry.updated >= self.stable_after:
                        self._flush(key, entry)
                    elif entry.text == entry.emitted and now - entry.updated > self.max_age:
                        self._lines.pop(key, None)

    async def flush_all(self) -> None:
        async with self._lock:
            for key, entry in list(self._lines.items()):
                if entry.text != entry.emitted:
                    self._flush(key, entry)

    # -- output --------------------------------------------------------------
    def _flush(self, key: str, entry: _Utterance) -> None:
        text, continuation = entry.text, False
        if entry.emitted and text.startswith(entry.emitted):
            text = text[len(entry.emitted):].strip()
            continuation = True
        entry.emitted = entry.text
        if not text:
            return

        stamp = datetime.now()
        body = f"...{text}" if continuation else text
        line = f"[{stamp:%H:%M:%S}] {entry.speaker}: {body}"
        if self.echo:
            print(line, flush=True)
        self.count += 1

        if self.on_line:
            try:
                self.on_line({
                    "ts": stamp.isoformat(timespec="seconds"),
                    "speaker": entry.speaker,
                    "text": text,
                    "continuation": continuation,
                    "line": line,
                })
            except Exception:
                pass  # a bad consumer must never break transcription

        if self.transcript_path:
            with self.transcript_path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        if self.jsonl_path:
            record = {
                "ts": stamp.isoformat(timespec="seconds"),
                "speaker": entry.speaker,
                "text": text,
                "continuation": continuation,
                "block": key,
            }
            with self.jsonl_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------- #
# Page helpers
# --------------------------------------------------------------------------- #


async def click_first_visible(page: Page, selector: str, timeout: float = 2000) -> bool:
    """Click the first visible match of `selector`; return False if there is none."""
    try:
        locator = page.locator(selector).first
        await locator.wait_for(state="visible", timeout=timeout)
        await locator.click(timeout=timeout)
        return True
    except (PlaywrightTimeoutError, PlaywrightError):
        return False


async def dismiss_overlays(page: Page) -> None:
    for label in DISMISS_LABELS:
        try:
            pattern = re.compile(rf"^\s*{re.escape(label)}\s*$", re.I)
            button = page.get_by_role("button", name=pattern)
            if await button.count():
                await button.first.click(timeout=1500)
                log(f"Dismissed overlay: {label!r}")
                await page.wait_for_timeout(300)
        except (PlaywrightTimeoutError, PlaywrightError):
            continue


def profile_cookie_dbs(profile_dir: Path) -> List[Path]:
    """Every plausible cookie store in a Chrome profile.

    Chrome 96+ keeps cookies in Default/Network/Cookies; older builds used
    Default/Cookies. Checking only the old path reports "signed out" for a
    profile that is in fact signed in.
    """
    candidates = [
        profile_dir / "Default" / "Network" / "Cookies",
        profile_dir / "Default" / "Cookies",
    ]
    candidates.extend(profile_dir.glob("Profile */Network/Cookies"))
    return candidates


def storage_state_has_session(path: Path) -> bool:
    """Whether an exported storage_state.json carries a real Google session."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return False
    return any(
        cookie.get("name") in GOOGLE_AUTH_COOKIES
        and "google" in cookie.get("domain", "")
        for cookie in data.get("cookies", [])
    )


def profile_has_google_session(profile_dir: Path) -> bool:
    """True when the profile holds real Google *auth* cookies.

    An exported storage_state.json counts as well, and is checked first: it is
    the portable form, and the only one a Linux container can actually use.
    """
    profile_dir = Path(profile_dir)
    if storage_state_has_session(profile_dir / STORAGE_STATE_NAME):
        return True

    placeholders = ",".join("?" * len(GOOGLE_AUTH_COOKIES))
    for db in profile_cookie_dbs(profile_dir):
        try:
            if not db.exists() or db.stat().st_size == 0:
                continue
            uri = f"file:{db.as_posix()}?mode=ro&immutable=1"
            with sqlite3.connect(uri, uri=True, timeout=1) as conn:
                if conn.execute(
                    "SELECT COUNT(*) FROM cookies "
                    f"WHERE host_key LIKE '%google.com' AND name IN ({placeholders})",
                    GOOGLE_AUTH_COOKIES,
                ).fetchone()[0]:
                    return True
        except Exception:
            continue
    return False


async def signed_in_account(page: Page) -> Optional[str]:
    """The Google account this browser is using, so the log can prove it."""
    try:
        body = (await page.inner_text("body"))[:4000]
        found = ACCOUNT_RE.search(body)
        if found:
            return found.group(1)
        for selector in ('a[aria-label*="Google Account" i]',
                         'button[aria-label*="Google Account" i]',
                         '[aria-label*="@" i]'):
            element = page.locator(selector).first
            if await element.count():
                label = (await element.get_attribute("aria-label")) or ""
                email = EMAIL_RE.search(label)
                if email:
                    return email.group(0)
    except Exception:
        pass
    return None


async def is_signed_in(page: Page) -> bool:
    """A signed-out profile gets a 'Your name' box on the green room screen."""
    try:
        guest = page.locator(
            'input[aria-label*="your name" i], input[placeholder*="your name" i]'
        )
        return await guest.count() == 0
    except PlaywrightError:
        return True


async def fill_guest_name(page: Page, name: str) -> None:
    box = page.locator(
        'input[aria-label*="your name" i], input[placeholder*="your name" i]'
    ).first
    try:
        if await box.count():
            await box.fill(name, timeout=3000)
            log(f"Filled guest name: {name!r}")
    except (PlaywrightTimeoutError, PlaywrightError):
        pass


async def _device_is_muted(page: Page, selector: str) -> Optional[bool]:
    """Read Meet's mute state off the toolbar button. None = state unreadable."""
    try:
        button = page.locator(selector).first
        if not await button.count():
            return None
        attr = await button.get_attribute("data-is-muted")
        if attr is not None:
            return attr == "true"
        label = (await button.get_attribute("aria-label")) or ""
        if re.search(r"turn on", label, re.I):
            return True
        if re.search(r"turn off", label, re.I):
            return False
    except PlaywrightError:
        return None
    return None


async def mute_devices(page: Page) -> None:
    """Mute mic (Ctrl+D) and camera (Ctrl+E), falling back to clicking buttons."""
    await page.bring_to_front()
    for shortcut, selector, name in (
        ("Control+d", MIC_BUTTON_SELECTOR, "microphone"),
        ("Control+e", CAM_BUTTON_SELECTOR, "camera"),
    ):
        if await _device_is_muted(page, selector) is True:
            log(f"{name.capitalize()} already off.")
            continue
        try:
            await page.keyboard.press(shortcut)
        except PlaywrightError:
            pass
        await page.wait_for_timeout(600)
        if await _device_is_muted(page, selector) is False:
            log(f"{shortcut} did not take; clicking the {name} button instead.")
            await click_first_visible(page, selector, timeout=2500)
            await page.wait_for_timeout(400)
        state = await _device_is_muted(page, selector)
        log(f"{name.capitalize()} off: {state if state is not None else 'unknown'}")


async def click_join(page: Page, timeout: float = 45.0) -> bool:
    """Click 'Join now' / 'Ask to join'. Returns True once a click lands."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        # Preferred: ARIA role + accessible name, which survives class churn.
        try:
            button = page.get_by_role("button", name=JOIN_BUTTON_RE)
            if await button.count():
                label = (await button.first.inner_text()).strip()
                await button.first.click(timeout=5000)
                log(f"Clicked {label!r}.")
                return True
        except (PlaywrightTimeoutError, PlaywrightError):
            pass
        # Fallback: exact text node inside any button-like ancestor.
        for text in ("Join now", "Ask to join", "Join anyway"):
            xpath = f'//span[normalize-space()="{text}"]/ancestor::button[1]'
            if await click_first_visible(page, xpath, 1200):
                log(f"Clicked {text!r} (text fallback).")
                return True
        await dismiss_overlays(page)
        await page.wait_for_timeout(1000)
    return False


async def wait_until_in_call(page: Page, timeout: float = 300.0) -> bool:
    """Wait for the in-call UI (the leave button), tolerating the lobby."""
    deadline = time.time() + timeout
    announced_lobby = False
    while time.time() < deadline:
        # Read the page BEFORE looking for the leave button. The lobby screen
        # has its own red hang-up button, so testing for that first reports
        # "In the call" while still waiting to be admitted -- and then every
        # in-call action fails, because the in-call toolbar does not exist yet.
        body = ""
        try:
            body = (await page.inner_text("body"))[:4000]
        except PlaywrightError:
            pass
        if LOBBY_RE.search(body):
            if not announced_lobby:
                log("In the lobby -- waiting for the host to admit us.")
                announced_lobby = True
            await page.wait_for_timeout(1500)
            continue
        # Quote Meet's own wording back to the console: "refused" alone gives
        # no clue whether the meeting is over, the code is wrong, or guests are
        # simply not allowed in without a signed-in host present.
        refusal = re.search(
            r"[^.\n]*(you can't join|can't join this|denied your request|"
            r"meeting hasn't started|call ended|not allowed to join|"
            r"no one responded|check your meeting code|return to home screen)[^.\n]*",
            body, re.I,
        )
        if refusal:
            log(f"Meet refused the join request: {refusal.group(0).strip()[:180]!r}")
            return False
        try:
            if await page.locator(LEAVE_BUTTON_SELECTOR).count():
                return True
        except PlaywrightError:
            pass
        await page.wait_for_timeout(1500)
    log("Still not admitted when the wait ran out.")
    await save_debug_shot(page, f"lobby-timeout-{int(time.time())}")
    return False


async def save_debug_shot(page: Page, name: str) -> None:
    """Screenshot the page when something inexplicable happens."""
    if not DEBUG_DIR:
        return
    try:
        target = Path(DEBUG_DIR)
        target.mkdir(parents=True, exist_ok=True)
        path = target / f"{name}.png"
        await page.screenshot(path=str(path))
        body = " ".join((await page.inner_text("body"))[:600].split())
        (target / f"{name}.txt").write_text(body, encoding="utf-8")
        log(f"Saved debug screenshot: {path}")
    except Exception as exc:
        log(f"Could not save screenshot: {type(exc).__name__}: {exc}")


async def _find_caption_button(page: Page):
    """Find the CC control by its accessible name, returning (handle, label).

    Matching `[aria-label*="caption"]` and taking `.first` is not good enough:
    the in-call UI also carries "Captions settings" and per-language entries, so
    `.first` regularly lands on a node that does nothing when clicked. Only an
    explicit "Turn on/off captions" label identifies the real toggle.
    """
    try:
        handles = await page.query_selector_all(
            'button[aria-label], div[role="button"][aria-label], '
            'span[role="button"][aria-label]'
        )
    except Exception:
        return None, ""
    for handle in handles:
        try:
            label = (await handle.get_attribute("aria-label")) or ""
        except Exception:
            continue
        if CAPTION_LABEL_RE.search(label):
            return handle, label
    return None, ""


async def _captions_are_on(page: Page) -> Optional[bool]:
    """True/False from the toggle's own label; None when the button is missing."""
    _, label = await _find_caption_button(page)
    if not label:
        return None
    if re.search(r"turn off", label, re.I):
        return True
    if re.search(r"turn on", label, re.I):
        return False
    return None


async def _wake_toolbar(page: Page) -> None:
    """Meet fades its control bar out; move the pointer so it renders again."""
    try:
        size = await page.evaluate("() => [window.innerWidth, window.innerHeight]")
        await page.mouse.move(size[0] / 2, size[1] - 40)
        await page.wait_for_timeout(400)
    except Exception:
        pass


async def _confirm_caption_dialog(page: Page) -> None:
    """Some builds pop a language/confirmation dialog after enabling captions."""
    for name in ("Turn on", "Apply", "Done", "Got it"):
        try:
            button = page.get_by_role("button", name=re.compile(rf"^\s*{name}\s*$", re.I))
            if await button.count():
                await button.first.click(timeout=1500)
                await page.wait_for_timeout(400)
        except Exception:
            continue


async def enable_captions(page: Page) -> bool:
    """Turn on live captions, trying every route Meet offers.

    Four strategies in order, verifying the toggle's label after each:
      1. click the CC button through JS,
      2. the real Meet shortcut, which is a bare `c`,
      3. Ctrl+Shift+C, kept because it was in the original spec,
      4. the More-options overflow menu.
    """
    await page.bring_to_front()
    await _wake_toolbar(page)

    if await _captions_are_on(page) is True:
        log("Captions already on.")
        return True

    # 1) Click the button itself. A JS click is deliberate: the toolbar fades
    #    out after a few seconds of inactivity, and Playwright's normal click
    #    refuses to act on a node it considers not visible -- which is why the
    #    earlier version silently timed out instead of clicking anything.
    handle, label = await _find_caption_button(page)
    if handle:
        log(f"Clicking caption button: {label!r}")
        for _ in range(2):
            try:
                await handle.evaluate("el => el.click()")
            except Exception:
                pass
            await page.wait_for_timeout(1200)
            await _confirm_caption_dialog(page)
            if await _captions_are_on(page) is True:
                log("Captions enabled via the CC button.")
                return True
            await _wake_toolbar(page)
    else:
        log("No caption button found by accessible name; trying shortcuts.")
        # Print what the toolbar actually offers. Without this, a renamed or
        # missing CC control is indistinguishable from a broken selector.
        try:
            labels = await page.evaluate(
                """() => Array.from(document.querySelectorAll(
                       'button[aria-label], div[role="button"][aria-label]'))
                     .map((e) => e.getAttribute('aria-label'))
                     .filter(Boolean).slice(0, 30)"""
            )
            size = await page.evaluate("() => [window.innerWidth, window.innerHeight]")
            log(f"Window {size[0]}x{size[1]}; buttons on the page: {labels}")
        except Exception:
            pass

    # 2) The documented Meet shortcut is a bare `c`. Ctrl+Shift+C is Chrome's
    #    DevTools inspector, not a Meet binding -- it was never going to work.
    for shortcut in ("c", "Control+Shift+c"):
        try:
            await page.keyboard.press(shortcut)
        except Exception:
            pass
        await page.wait_for_timeout(1200)
        await _confirm_caption_dialog(page)
        if await _captions_are_on(page) is True:
            log(f"Captions enabled via the {shortcut!r} shortcut.")
            return True

    # 3) Overflow menu, where narrow windows park the CC entry.
    try:
        await _wake_toolbar(page)
        if await click_first_visible(page, 'button[aria-label*="More options" i]', 3000):
            await page.wait_for_timeout(800)
            try:
                names = await page.evaluate(
                    """() => Array.from(document.querySelectorAll('[role="menuitem"]'))
                         .map((e) => (e.innerText || '').trim()).filter(Boolean)"""
                )
                log(f"More-options menu: {names}")
            except Exception:
                pass
            item = page.get_by_role("menuitem", name=re.compile(r"caption|subtitle", re.I))
            if await item.count():
                await item.first.click(timeout=2500)
                await page.wait_for_timeout(1500)
                await _confirm_caption_dialog(page)
    except Exception:
        pass

    state = await _captions_are_on(page)
    if state is True:
        log("Captions enabled via the More-options menu.")
        return True

    await save_debug_shot(page, f"captions-{int(time.time())}")
    log("Could not confirm captions are on -- scraping anyway.")
    log("If no captions appear: turn them on by hand in the window; scraping continues.")
    return False


CHAT_BOX_SELECTOR = (
    'textarea[aria-label*="Send a message" i], '
    'textarea[placeholder*="Send a message" i], '
    'div[role="textbox"][aria-label*="message" i], '
    'textarea[aria-label*="message" i]'
)
CHAT_OPEN_SELECTOR = (
    'button[aria-label*="Chat with everyone" i], '
    'button[aria-label*="chat" i]'
)
# Meet rejects very long chat messages; keep well inside the limit.
CHAT_MAX_CHARS = 900


async def send_chat_message(page: Page, text: str) -> bool:
    """Post a message into the meeting chat.

    Opens the chat panel if it is closed, then types and sends. Newlines are
    flattened because Enter is what sends the message.
    """
    message = " ".join(str(text).split())[:CHAT_MAX_CHARS]
    if not message:
        return False
    async def visible_box():
        """The chat input, but only once it is actually usable.

        Presence is not enough: the chat textarea exists in the DOM while the
        panel is closed, so counting elements would skip opening the panel and
        then fail to type into a hidden box.
        """
        locator = page.locator(CHAT_BOX_SELECTOR).first
        try:
            if await locator.count() and await locator.is_visible():
                return locator
        except Exception:
            pass
        return None

    try:
        box = await visible_box()
        if box is None:
            await _wake_toolbar(page)
            await click_first_visible(page, CHAT_OPEN_SELECTOR, 4000)
            await page.wait_for_timeout(1200)
            box = await visible_box()
        if box is None:
            log("Could not find the chat box; message not sent.")
            await save_debug_shot(page, f"chat-{int(time.time())}")
            return False
        await box.click(timeout=4000)
        await box.fill(message, timeout=4000)
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(400)
        log(f"Chat sent: {message[:80]!r}")
        return True
    except Exception as exc:
        log(f"Could not send chat message: {type(exc).__name__}: {exc}")
        return False


async def set_caption_language(page: Page, language: str) -> bool:
    """Tell Meet which language people will be SPEAKING.

    Meet does not auto-detect an arbitrary language: captions transcribe the
    configured spoken language, so leaving it on English while people speak
    Telugu produces nonsense rather than Telugu text. The scraper itself is
    language-agnostic -- it copies whatever Meet renders.
    """
    if not language:
        return True
    log(f"Setting caption language to {language!r}.")
    await _wake_toolbar(page)

    opened = False
    for selector in ('button[aria-label*="Captions settings" i]',
                     'button[aria-label*="caption" i][aria-label*="setting" i]',
                     'button[aria-label*="caption" i][aria-label*="language" i]'):
        if await click_first_visible(page, selector, 3000):
            opened = True
            break
    if not opened and await click_first_visible(page, 'button[aria-label*="More options" i]', 3000):
        await page.wait_for_timeout(700)
        item = page.get_by_role("menuitem", name=re.compile(r"caption|subtitle", re.I))
        try:
            if await item.count():
                await item.first.click(timeout=2500)
                opened = True
        except Exception:
            pass
    if not opened:
        log("Could not open captions settings; leaving the language as it is.")
        await save_debug_shot(page, f"caption-language-{int(time.time())}")
        return False

    await page.wait_for_timeout(1200)
    wanted = re.compile(re.escape(language), re.I)

    try:  # the picker is a combobox that must be opened before its options exist
        combo = page.get_by_role("combobox")
        if await combo.count():
            await combo.first.click(timeout=3000)
            await page.wait_for_timeout(700)
    except Exception:
        pass

    for role in ("option", "menuitemradio", "menuitem"):
        try:
            option = page.get_by_role(role, name=wanted)
            if not await option.count():
                continue
            await option.first.click(timeout=3000)
            await page.wait_for_timeout(700)
            for label in ("Apply", "Done", "Save"):
                button = page.get_by_role(
                    "button", name=re.compile(rf"^\s*{label}\s*$", re.I))
                if await button.count():
                    await button.first.click(timeout=2000)
                    break
            log(f"Caption language set to {language!r}.")
            return True
        except Exception:
            continue

    log(f"{language!r} was not offered in the caption language list.")
    log("Meet only lists languages it supports for the host's account type.")
    await save_debug_shot(page, f"caption-language-{int(time.time())}")
    return False


async def install_caption_observer(context: BrowserContext, page: Page, sink: CaptionSink) -> None:
    """Expose the Python callback once, then inject the DOM observer."""
    try:
        await context.expose_binding("__meetCaption", sink.on_caption)
    except PlaywrightError:
        pass  # already exposed on this context
    await context.add_init_script(CAPTION_OBSERVER_JS)  # survives reloads
    result = await page.evaluate(CAPTION_OBSERVER_JS)
    log(f"Caption observer: {result}")


async def call_is_alive(page: Page) -> bool:
    try:
        if page.is_closed():
            return False
        body = (await page.inner_text("body"))[:3000]
        if LOBBY_RE.search(body):
            return True          # pushed back to the lobby, but still connected
        if await page.locator(LEAVE_BUTTON_SELECTOR).count():
            return True
    # A closed window or a dead driver connection both mean "no longer in the
    # call", so end the listening loop cleanly instead of raising.
    except Exception:
        return False
    return not re.search(r"you(?:'ve| have) left|call ended|return to home screen", body, re.I)


PARTICIPANT_COUNT_JS = r"""
() => {
  // 1) The people button carries the count, e.g. "People (3)" or a badge.
  const sels = [
    'button[aria-label*="participant" i]',
    'button[aria-label*="Show everyone" i]',
    'button[aria-label*="People" i]',
  ];
  for (const sel of sels) {
    const btn = document.querySelector(sel);
    if (!btn) continue;
    const label = btn.getAttribute('aria-label') || '';
    const m = label.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
    const badge = (btn.innerText || '').match(/(\d+)/);
    if (badge) return parseInt(badge[1], 10);
  }
  // 2) Otherwise count distinct participant tiles in the grid.
  const ids = new Set(
    Array.from(document.querySelectorAll('[data-participant-id]'))
      .map((el) => el.getAttribute('data-participant-id'))
      .filter(Boolean)
  );
  if (ids.size) return ids.size;
  return null;   // unknown -- caller must not treat this as "empty"
}
"""

# Meet says this outright when everyone else has gone.
ALONE_TEXT_RE = re.compile(
    r"you're the only one here|you are the only one here|no one else is here",
    re.I,
)


async def is_alone(page: Page) -> Optional[bool]:
    """True when the bot appears to be the only participant. None = unknown.

    Unknown is deliberately distinct from False: an unreadable page must never
    be mistaken for an empty meeting, or the bot would hang up on a live call.
    """
    try:
        body = (await page.inner_text("body"))[:3000]
        if ALONE_TEXT_RE.search(body):
            return True
        count = await page.evaluate(PARTICIPANT_COUNT_JS)
    except Exception:
        return None
    if count is None:
        return None
    return count <= 1


async def leave_call(page: Page) -> None:
    try:
        if page.is_closed():
            return
        if await click_first_visible(page, LEAVE_BUTTON_SELECTOR, timeout=3000):
            log("Left the call.")
            await page.wait_for_timeout(1000)
    # Broad on purpose: leaving the call can itself tear down the browser, and
    # Playwright signals a dead driver connection with a bare Exception rather
    # than a PlaywrightError. Nothing here is worth failing a good run over.
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# Modes
# --------------------------------------------------------------------------- #


async def _has_google_session(context: BrowserContext) -> bool:
    """True once Google has dropped a signed-in session cookie on this profile."""
    try:
        cookies = await context.cookies("https://accounts.google.com")
    except PlaywrightError:
        return False
    names = {c.get("name") for c in cookies}
    return bool(names & {"SID", "__Secure-1PSID", "__Secure-3PSID"})


async def export_storage_state(context: BrowserContext, profile_dir: Path) -> Optional[Path]:
    """Write the context's cookies to <profile>/storage_state.json."""
    path = Path(profile_dir) / STORAGE_STATE_NAME
    try:
        await context.storage_state(path=str(path))
    except Exception as exc:
        log(f"Could not export storage state: {type(exc).__name__}: {exc}")
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        cookies = [c for c in data.get("cookies", []) if "google" in c.get("domain", "")]
    except Exception:
        cookies = []
    log(f"Exported {len(cookies)} Google cookie(s) to {path}")
    log("This file is what the container uses; a Chrome profile alone is not portable.")
    return path


async def run_login(context: BrowserContext, profile_dir: Path, timeout: float = 900.0) -> bool:
    page = context.pages[0] if context.pages else await context.new_page()
    await page.goto("https://accounts.google.com/", wait_until="domcontentloaded")
    log("Sign in to your Google account in the browser window that just opened.")
    log("Then press Enter here, or simply close the browser window -- either works.")

    loop = asyncio.get_running_loop()

    # Three independent finish signals, because we cannot assume an interactive
    # terminal: isatty() lies when the script is launched by another tool, so a
    # bare input() would blow up with EOFError instead of waiting.
    enter = asyncio.Event()

    def _wait_for_enter() -> None:
        try:
            line = sys.stdin.readline()
        except Exception:
            return
        if line != "":  # "" means EOF (no real terminal), not a keypress
            loop.call_soon_threadsafe(enter.set)

    # Daemon thread: if nobody ever presses Enter it dies with the process
    # instead of holding up interpreter shutdown.
    threading.Thread(target=_wait_for_enter, daemon=True).start()

    closed = asyncio.Event()
    context.on("close", lambda *_: loop.call_soon_threadsafe(closed.set))

    deadline = time.time() + timeout
    while time.time() < deadline:
        if enter.is_set() or closed.is_set() or page.is_closed():
            break
        if await _has_google_session(context):
            log("Google session detected.")
            await asyncio.sleep(3)  # let Chrome flush the profile to disk
            break
        await asyncio.sleep(2)
    else:
        log("Timed out waiting for sign-in.")

    # Enter/close can fire without a real login, so confirm before claiming
    # success -- reporting a saved session that does not exist would send the
    # next run straight into a guest join.
    signed_in = await _has_google_session(context)
    if signed_in:
        log(f"Signed in. Profile saved to {profile_dir}; future runs reuse this session.")
        await export_storage_state(context, profile_dir)
    else:
        log("No Google session was established -- the profile is still signed out.")
        log("Re-run `python meet_listener.py --login` and complete the sign-in.")
    return signed_in


async def run_meeting(
    context: BrowserContext,
    args: argparse.Namespace,
    sink: CaptionSink,
    stop: Optional[asyncio.Event] = None,
    manage_signals: bool = True,
    on_status: Optional[Callable[[str, str], None]] = None,
    on_assistant: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> int:
    """Join, listen, and leave.

    `stop` lets an embedder (the API server) end the session from outside;
    `manage_signals` is disabled there because a server owns its own Ctrl+C.
    """
    def stage(code: str, message: str) -> None:
        """Log a milestone and report it to any embedder watching progress."""
        log(message)
        if on_status:
            try:
                on_status(code, message)
            except Exception:
                pass

    page = context.pages[0] if context.pages else await context.new_page()
    page.on("dialog", lambda d: asyncio.ensure_future(d.dismiss()))
    page.set_default_timeout(20_000)

    stage("opening", f"Opening {args.url}")
    await page.goto(args.url, wait_until="domcontentloaded", timeout=60_000)
    try:
        await page.wait_for_load_state("networkidle", timeout=15_000)
    except PlaywrightTimeoutError:
        pass  # Meet keeps sockets open; domcontentloaded is enough
    await page.wait_for_timeout(2500)
    stage("green_room", "Meet page loaded; in the green room.")
    await dismiss_overlays(page)

    if not await is_signed_in(page):
        # Refusing here is the point: a silent guest fallback looks like a
        # working bot right up until nobody admits it, and the real cause
        # (an empty profile) never appears in the logs.
        if getattr(args, "require_login", False):
            profile = Path(getattr(args, "profile", USER_DATA_DIR))
            # Cookies on disk but a signed-out page means the profile did not
            # load, not that it is empty. Chrome allows exactly one browser per
            # user-data dir, so the usual cause is the container holding it.
            if profile_has_google_session(profile):
                log(f"REFUSING TO JOIN: {profile} DOES hold a Google session, but "
                    "this browser did not load it.")
                log("Chrome allows only one browser per profile directory, so the "
                    "profile is almost certainly open elsewhere.")
                log("If the container is running, it has the same directory mounted:")
                log("    docker stop meet-listener")
                return 6
            log("REFUSING TO JOIN: this profile has no Google session, and the "
                "run is configured to use the signed-in account only.")
            log(f"Fix it with:  python meet_listener.py --login --profile {profile}")
            log("Then confirm it prints 'Signed in.' before trying again.")
            return 5
        if args.guest:
            log(f"Entering guest name {args.display_name!r}.")
        else:
            log("This profile is not signed in to Google -- joining as a guest.")
            log("Run `python meet_listener.py --login` once to sign in permanently.")
        await fill_guest_name(page, args.display_name)
    else:
        account = await signed_in_account(page)
        stage("signed_in", f"Joining as the signed-in Google account"
                           f"{': ' + account if account else ' (name comes from the account)'}.")

    await mute_devices(page)
    stage("muted", "Microphone and camera off.")

    if not await click_join(page, timeout=args.join_timeout):
        log("Could not find a Join button. Is the link correct and the meeting live?")
        # Quote the page back: "not live", "invalid code" and "signed-out" all
        # look identical from the outside without it.
        try:
            snippet = " ".join((await page.inner_text("body"))[:300].split())
            log(f"Page says: {snippet!r}")
        except Exception:
            pass
        return 2

    stage("joining", "Join requested; waiting to be let in.")
    if not await wait_until_in_call(page, timeout=args.admit_timeout):
        log("Never made it into the call (not admitted, or the meeting ended).")
        return 3
    stage("in_call", "In the call.")
    await dismiss_overlays(page)

    assistant = None
    if getattr(args, "assistant", False):
        from assistant import Assistant  # imported lazily: needs aiohttp
        assistant = Assistant(
            send=lambda text: send_chat_message(page, text),
            ollama_url=getattr(args, "ollama_url", "http://localhost:11434"),
            model=getattr(args, "ollama_model", "llama3.2"),
            wake_words=[w.strip() for w in
                        getattr(args, "wake_words", "astra,yo bot").split(",") if w.strip()],
            listen_window=float(getattr(args, "listen_window", 20)),
            reply_silence=float(getattr(args, "reply_silence", 4)),
            greeting=getattr(args, "greeting", "") or None,
            log=log,
            on_state=on_assistant,
        )
        # Chain onto whatever the embedder already installed, so the API server
        # still receives every line.
        previous = sink.on_line

        def _fan_out(record, _prev=previous, _bot=assistant):
            if _prev:
                _prev(record)
            _bot.feed(record)

        sink.on_line = _fan_out
        log(f"Assistant on. Wake words: {getattr(args, 'wake_words', 'astra,yo bot')!r}; "
            f"model {getattr(args, 'ollama_model', 'llama3.2')!r}.")

    captions_confirmed = await enable_captions(page)
    if getattr(args, "caption_language", ""):
        await set_caption_language(page, args.caption_language)
    stage("captions" if captions_confirmed else "captions_unconfirmed",
          "Captions on." if captions_confirmed else "Captions could not be confirmed.")
    await install_caption_observer(context, page, sink)

    stop = stop or asyncio.Event()
    if manage_signals:
        _install_signal_handlers(stop)
    janitor = asyncio.create_task(sink.janitor(stop))
    alone_since: Optional[float] = None
    # Read through getattr so an embedder building its own Namespace does not
    # have to know about every option this function has grown.
    alone_grace = float(getattr(args, "alone_grace", 60) or 0)

    next_cc_retry = time.time() + CC_RETRY_SECONDS
    next_status = time.time() + STATUS_SECONDS
    deadline = time.time() + args.max_minutes * 60 if args.max_minutes else None
    stage("listening", "Listening for captions.")
    print("-" * 72, flush=True)

    try:
        while not stop.is_set():
            try:
                await asyncio.wait_for(
                    stop.wait(), timeout=0.5 if assistant is not None else 5.0)
                break
            except asyncio.TimeoutError:
                pass
            if not await call_is_alive(page):
                log("The call ended.")
                break
            if deadline and time.time() > deadline:
                log(f"Reached the {args.max_minutes} minute limit.")
                break
            # Re-inject after a reload or a renderer crash.
            try:
                if not await page.evaluate("() => !!window.__meetCapInstalled"):
                    log("Caption observer vanished -- reinstalling.")
                    await page.evaluate(CAPTION_OBSERVER_JS)
            except Exception:
                pass  # page navigating or browser going away; the next tick retries

            now = time.time()

            # Caption watchdog. Enabling captions once at join is not enough:
            # the CC control can be re-rendered, the host can switch it off, or
            # the first click can land before the toolbar is interactive. Keep
            # asserting the state until captions actually produce text.
            if sink.count == 0 and now >= next_cc_retry:
                next_cc_retry = now + CC_RETRY_SECONDS
                try:
                    state = await _captions_are_on(page)
                    if state is not True:
                        log("Captions are still off -- retrying the CC control.")
                        captions_confirmed = await enable_captions(page)
                    else:
                        if not captions_confirmed:
                            captions_confirmed = True
                            log("Captions are on; waiting for someone to speak.")
                        # Captions are on but nothing is arriving. Either the
                        # room is silent, or Google renamed the caption nodes.
                        seen = await page.evaluate("() => !!window.__meetCapRootSeen")
                        if not seen:
                            log("Captions on, but the caption container was not "
                                "found in the DOM -- the selectors are probably stale.")
                            log("Fix: update TEXT_SELECTORS / ROOT_SELECTORS in "
                                "CAPTION_OBSERVER_JS (see RUNNING.md, Part 5).")
                except Exception:
                    pass

            # Empty meeting: hang up rather than idle in a room by ourselves.
            # A grace period covers the gap while others are still connecting,
            # and an unreadable count (None) never counts as empty.
            if alone_grace > 0:
                alone = await is_alone(page)
                if alone is True:
                    alone_since = alone_since or now
                    waited = now - alone_since
                    if waited >= alone_grace:
                        log(f"Alone in the meeting for {int(waited)}s -- leaving.")
                        break
                    if alone_since == now:
                        log(f"Nobody else here; leaving in {int(alone_grace)}s "
                            f"unless someone joins.")
                elif alone is False and alone_since is not None:
                    log("Someone joined -- staying.")
                    alone_since = None

            if assistant is not None:
                await assistant.tick()

            if now >= next_status:
                next_status = now + STATUS_SECONDS
                log(f"Status: {sink.count} caption line(s) captured so far.")
    finally:
        stop.set()
        janitor.cancel()
        await asyncio.gather(janitor, return_exceptions=True)
        await sink.flush_all()
        stage("leaving", "Leaving the call.")
        await leave_call(page)

    print("-" * 72, flush=True)
    log(f"Captured {sink.count} caption line(s).")
    if sink.transcript_path:
        log(f"Transcript: {sink.transcript_path}")
    return 0


def _install_signal_handlers(stop: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, AttributeError, ValueError):
            # Windows: add_signal_handler is unavailable, use the sync handler.
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Join a Google Meet and stream its live captions to stdout.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("meet_url", nargs="?", default=None,
                        help="Meeting URL, positionally. Same as --url.")
    parser.add_argument("--allow-guest", action="store_true",
                        help="Permit an anonymous join when the profile has no Google "
                             "session. OFF by default: the bot joins as your signed-in "
                             "account, under that account's own name.")
    parser.add_argument("--url", default=MEET_URL, help="Google Meet URL to join.")
    parser.add_argument("--profile", default=str(USER_DATA_DIR),
                        help="Persistent Chromium user-data directory.")
    parser.add_argument("--login", action="store_true",
                        help="Open a browser to sign in to Google, then exit.")
    parser.add_argument("--export-state", action="store_true",
                        help="Re-export storage_state.json from an already signed-in "
                             "profile, without logging in again. This is the file the "
                             "container needs; a Chrome profile is not portable to Linux.")
    parser.add_argument("--storage-state", default="",
                        help="Start from an exported storage_state.json instead of a "
                             "profile directory. Used by the container.")
    parser.add_argument("--display-name", default=DISPLAY_NAME,
                        help="Guest name. ONLY used with --allow-guest; a signed-in "
                             "join always shows your Google account's own name.")
    parser.add_argument("--channel", default="chrome",
                        help="Browser channel: 'chrome', 'msedge', or '' for bundled Chromium.")
    parser.add_argument("--headless", action="store_true",
                        help="Run without a window (Meet is far more likely to block this).")
    parser.add_argument("--transcript", default="",
                        help="Also append captions to this text file.")
    parser.add_argument("--jsonl", default="",
                        help="Also append captions to this JSON Lines file.")
    parser.add_argument("--max-minutes", type=float, default=0,
                        help="Leave after this many minutes (0 = stay until the call ends).")
    parser.add_argument("--join-timeout", type=float, default=45,
                        help="Seconds to look for the Join button.")
    parser.add_argument("--admit-timeout", type=float, default=300,
                        help="Seconds to wait in the lobby for the host to admit us.")
    parser.add_argument("--stable-after", type=float, default=1.5,
                        help="Seconds a caption block must stay unchanged before it prints.")
    parser.add_argument("--caption-language", default=os.environ.get("MEET_CAPTION_LANGUAGE", ""),
                        help="Spoken language for Meet to transcribe, e.g. Telugu, "
                             "Hindi, Spanish. Meet does not auto-detect: leave this "
                             "unset only if the meeting is in the account default.")
    parser.add_argument("--greeting", default=os.environ.get("MEET_GREETING", ""),
                        help="What Astra says in the chat when woken. "
                             "Empty uses the built-in line.")
    parser.add_argument("--assistant", action="store_true",
                        help="Answer questions in the meeting chat when someone says "
                             "a wake word. Needs a local Ollama server.")
    parser.add_argument("--wake-words", default=os.environ.get("MEET_WAKE_WORDS", "astra,yo bot"),
                        help="Comma-separated wake words.")
    parser.add_argument("--ollama-url", default=os.environ.get("MEET_OLLAMA_URL", "http://localhost:11434"),
                        help="Ollama server. From a container use host.docker.internal.")
    parser.add_argument("--ollama-model", default=os.environ.get("MEET_OLLAMA_MODEL", "llama3.2"),
                        help="Model name for Ollama.")
    parser.add_argument("--listen-window", type=float, default=20,
                        help="Seconds to keep listening after being woken.")
    parser.add_argument("--reply-silence", type=float, default=4,
                        help="Seconds of quiet that mean the question is finished.")
    parser.add_argument("--alone-grace", type=float, default=60,
                        help="Leave after this many seconds alone in the meeting. 0 disables.")
    args = parser.parse_args(argv)

    if args.meet_url:
        args.url = args.meet_url

    # Signed-in is the default and anonymous is the exception, not the reverse.
    # A guest join shows up under an arbitrary name and needs manual admission,
    # so it only ever happens when explicitly asked for.
    args.guest = bool(args.allow_guest)
    args.require_login = not args.allow_guest
    if args.login:
        args.guest = False
        args.require_login = False   # logging in is how the session gets created
    return args


async def amain(args: argparse.Namespace) -> int:
    profile_dir = Path(args.profile).expanduser()
    profile_dir.mkdir(parents=True, exist_ok=True)

    sink = CaptionSink(
        transcript_path=Path(args.transcript).expanduser() if args.transcript else None,
        jsonl_path=Path(args.jsonl).expanduser() if args.jsonl else None,
        stable_after=args.stable_after,
    )

    async with async_playwright() as pw:
        launch_opts: Dict[str, Any] = dict(
            headless=args.headless,
            args=CHROMIUM_ARGS,
            ignore_default_args=IGNORED_DEFAULT_ARGS,
        )
        context_opts: Dict[str, Any] = dict(
            permissions=["microphone", "camera"],
            locale="en-US",
            no_viewport=not args.headless,
            viewport={"width": 1440, "height": 900} if args.headless else None,
        )

        async def _open(channel: Optional[str]):
            """Return (context, browser); browser is None for a saved profile."""
            opts = dict(launch_opts)
            if channel:
                opts["channel"] = channel
            if args.storage_state:
                # Portable credentials: a fresh browser seeded with exported
                # cookies. This is how the Linux container reuses a session that
                # was created by Chrome on another operating system.
                browser = await pw.chromium.launch(**opts)
                return await browser.new_context(
                    storage_state=args.storage_state, **context_opts), browser
            if args.guest:
                # Incognito: a fresh context with no user-data dir, so Google
                # sees a brand new anonymous browser and never asks to log in.
                browser = await pw.chromium.launch(**opts)
                return await browser.new_context(**context_opts), browser
            return await pw.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir), **opts, **context_opts
            ), None

        try:
            context, browser = await _open(args.channel or None)
        except PlaywrightError as exc:
            if not args.channel:
                raise
            log(f"Channel {args.channel!r} unavailable ({exc}); using bundled Chromium.")
            context, browser = await _open(None)

        if args.guest:
            log(f"Guest / incognito mode -- joining as {args.display_name!r}.")

        try:
            await context.grant_permissions(
                ["microphone", "camera"], origin="https://meet.google.com"
            )
            await context.add_init_script(STEALTH_JS)
            context.set_default_timeout(20_000)

            if args.login:
                return 0 if await run_login(context, profile_dir) else 4
            if args.export_state:
                page = context.pages[0] if context.pages else await context.new_page()
                await page.goto("https://myaccount.google.com/",
                                wait_until="domcontentloaded", timeout=45_000)
                await page.wait_for_timeout(2500)
                if not await _has_google_session(context):
                    log(f"{profile_dir} has no Google session to export. Run --login first.")
                    return 4
                return 0 if await export_storage_state(context, profile_dir) else 4
            return await run_meeting(context, args, sink)
        finally:
            await sink.flush_all()
            try:
                await context.close()
            # Closing the last page of a persistent context exits Chrome, which
            # drops the driver connection; close() then raises a plain
            # Exception ("Connection closed while reading from the driver").
            # The captions are already flushed at this point, so a shutdown
            # race must not turn a successful run into a traceback.
            except Exception as exc:
                log(f"Browser was already gone at shutdown ({type(exc).__name__}).")
            if browser is not None:
                try:
                    await browser.close()
                except Exception:
                    pass


def main() -> int:
    args = parse_args()
    if not (args.login or args.export_state) and "abc-defg-hij" in args.url:
        log("Set a real meeting link with --url or the MEET_URL environment variable.")
        return 1
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    try:
        return asyncio.run(amain(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
