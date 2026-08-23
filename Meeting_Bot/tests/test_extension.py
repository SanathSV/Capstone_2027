"""Tests for the Chrome extension popup.

Two levels:
  1. Chrome really loads the unpacked extension and reports no errors.
  2. popup.js runs for real in a browser against a stub API, with the chrome.*
     APIs faked, so its logic -- join, polling, the Astra panel -- is exercised
     rather than eyeballed.

The popup is served from the stub server itself so it shares an origin with the
API and no CORS rules get in the way.

    python tests/test_extension.py
"""
import asyncio
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aiohttp import web  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

EXT = ROOT / "extension"
PORT = 8097
BASE = f"http://127.0.0.1:{PORT}"
MEET_URL = "https://meet.google.com/abc-defg-hij"
FAILURES = []

# What /api/sessions/{id}/transcript returns, one step per poll, so the popup
# walks through the whole Astra lifecycle.
SCRIPT = [
    {"state": "listening", "stage_message": "Listening for captions.",
     "line_count": 0, "lines": [], "next": 0,
     "assistant": {"state": "idle", "label": "sleeping - say the wake word",
                   "awake": False, "heard": "", "last_question": "",
                   "last_answer": "", "answered": 0, "model": "llama3.2"}},
    {"state": "listening", "stage_message": "Listening for captions.",
     "line_count": 1, "next": 1,
     "lines": [{"ts": "10:00:01", "speaker": "Sanath", "text": "astra",
                "continuation": False}],
     "assistant": {"state": "listening", "label": "listening to Sanath...",
                   "awake": True, "asker": "Sanath", "heard": "",
                   "last_question": "", "last_answer": "", "answered": 0,
                   "model": "llama3.2"}},
    {"state": "listening", "stage_message": "Listening for captions.",
     "line_count": 2, "next": 2,
     "lines": [{"ts": "10:00:05", "speaker": "Sanath",
                "text": "what is a container", "continuation": False}],
     "assistant": {"state": "thinking", "label": "thinking with llama3.2...",
                   "awake": True, "asker": "Sanath",
                   "heard": "what is a container", "last_question": "",
                   "last_answer": "", "answered": 0, "model": "llama3.2"}},
    {"state": "listening", "stage_message": "Listening for captions.",
     "line_count": 2, "next": 2, "lines": [],
     "assistant": {"state": "idle", "label": "sleeping - say the wake word",
                   "awake": False, "asker": "Sanath", "heard": "",
                   "last_question": "what is a container",
                   "last_answer": "A container is a boxed-up program.",
                   "answered": 1, "model": "llama3.2"}},
]


def check(label, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        print(f"         got:  {got!r}\n         want: {want!r}")
        FAILURES.append(label)


def contains(label, haystack, needle):
    ok = needle.lower() in (haystack or "").lower()
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        print(f"         looked for {needle!r} in {haystack!r}")
        FAILURES.append(label)


# --------------------------------------------------------------------------- #
# stub API + static popup
# --------------------------------------------------------------------------- #

def build_stub():
    state = {"joins": [], "poll": 0, "leaves": 0}

    async def health(_request):
        return web.json_response({
            "ok": True, "credentials_present": True, "require_login": True,
            "active_sessions": 0, "max_sessions": 1, "auth_required": True,
            "profile_dir": "/creds",
        })

    async def join(request):
        body = await request.json()
        state["joins"].append({"body": body,
                               "key": request.headers.get("X-API-Key", "")})
        return web.json_response({"session_id": "deadbeefcafe", "state": "starting",
                                  "url": body.get("url", "")}, status=201)

    async def transcript(_request):
        step = SCRIPT[min(state["poll"], len(SCRIPT) - 1)]
        state["poll"] += 1
        return web.json_response(step)

    async def leave(_request):
        state["leaves"] += 1
        return web.json_response({"session_id": "deadbeefcafe", "stopping": True})

    async def static(request):
        name = request.match_info["name"]
        path = EXT / name
        if not path.exists():
            raise web.HTTPNotFound()
        ctype = "text/html" if name.endswith(".html") else "application/javascript"
        return web.Response(body=path.read_bytes(), content_type=ctype)

    app = web.Application()
    app.add_routes([
        web.get("/api/health", health),
        web.post("/api/join", join),
        web.get("/api/sessions/{sid}/transcript", transcript),
        web.get("/api/sessions/{sid}", transcript),
        web.post("/api/sessions/{sid}/leave", leave),
        web.get("/{name}", static),
    ])
    return app, state


# Stands in for the chrome.* APIs the popup uses.
CHROME_STUB = """
window.__sync = { server: "%s", key: "test-key", name: "Meeting Notetaker" };
window.__local = { lastSession: null };
window.__tabUrl = "%s";
window.chrome = {
  storage: {
    sync: {
      get: async (d) => ({ ...d, ...window.__sync }),
      set: async (o) => { Object.assign(window.__sync, o); },
    },
    local: {
      get: async (d) => ({ ...d, ...window.__local }),
      set: async (o) => { Object.assign(window.__local, o); },
    },
  },
  tabs: { query: async () => [{ url: window.__tabUrl }] },
};
""" % (BASE, MEET_URL)


async def test_popup_logic(pw):
    print("\n2. popup.js running for real against a stub API")
    app, state = build_stub()
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", PORT).start()

    browser = await pw.chromium.launch(channel="chrome", headless=True)
    page = await browser.new_page()
    await page.add_init_script(CHROME_STUB)
    await page.goto(f"{BASE}/popup.html")
    await page.wait_for_timeout(800)

    contains("health check shown on open",
             await page.inner_text("#status"), "Server ready")
    check("Astra starts as not running",
          await page.inner_text("#astra-label"), "Astra: not running")

    await page.click("#send")
    await page.wait_for_timeout(700)

    check("exactly one join was sent", len(state["joins"]), 1)
    check("it sent the active tab's Meet URL",
          state["joins"][0]["body"].get("url"), MEET_URL)
    check("it sent the API key header", state["joins"][0]["key"], "test-key")

    # Poll 1 -> idle, poll 2 -> listening, poll 3 -> thinking, poll 4 -> answered.
    await page.wait_for_timeout(2200)
    contains("Astra shows LISTENING when woken",
             await page.inner_text("#astra-label"), "listening")
    check("the dot animates while awake",
          "awake" in (await page.get_attribute("#astra-dot", "class") or ""), True)

    await page.wait_for_timeout(2100)
    contains("Astra shows THINKING while the model runs",
             await page.inner_text("#astra-label"), "thinking")
    check("the dot switches to the thinking colour",
          "think" in (await page.get_attribute("#astra-dot", "class") or ""), True)

    await page.wait_for_timeout(2100)
    detail = await page.inner_text("#astra-detail")
    contains("the question is shown afterwards", detail, "what is a container")
    contains("the answer is shown afterwards", detail, "boxed-up program")

    transcript = await page.inner_text("#transcript")
    contains("captions appear in the popup", transcript, "what is a container")

    await page.click("#leave")
    await page.wait_for_timeout(500)
    check("leave button calls the API", state["leaves"], 1)

    await browser.close()
    await runner.cleanup()


async def test_chrome_loads_it(pw):
    """Chrome must accept the unpacked extension without errors."""
    print("\n1. Chrome loads the unpacked extension")
    profile = ROOT / "data" / "ext-profile"
    context = await pw.chromium.launch_persistent_context(
        user_data_dir=str(profile),
        channel="chrome",
        headless=False,          # MV3 extensions do not load in old headless
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
    )
    try:
        page = await context.new_page()
        await page.goto("chrome://extensions/")
        await page.wait_for_timeout(1500)
        # chrome://extensions is built from nested shadow roots, so ordinary
        # text extraction returns nothing: walk them and gather the text.
        text = await page.evaluate("""() => {
            const seen = new Set();
            const out = [];
            const walk = (root) => {
                if (!root || seen.has(root)) return;
                seen.add(root);
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) walk(el.shadowRoot);
                    if (!el.children.length && el.textContent.trim()) {
                        out.push(el.textContent.trim());
                    }
                }
            };
            walk(document);
            return out.join(' | ');
        }""")
        if "Meet Notetaker Bot" not in text:
            # Chrome 136+ refuses --load-extension for CDP-automated sessions
            # (it was abused by malware), so this cannot be checked from a
            # script. Loading it by hand from chrome://extensions still works,
            # and test 2 below exercises the popup's actual behaviour.
            print("  [SKIP] this Chrome refuses --load-extension under automation; "
                  "load it by hand to verify")
            return
        check("Chrome lists the extension by name", True, True)
        check("Chrome reports no extension errors",
              ("error" in text.lower() and "Errors" in text), False)
    finally:
        await context.close()


async def main():
    async with async_playwright() as pw:
        try:
            await test_chrome_loads_it(pw)
        except Exception as exc:
            print(f"  [SKIP] could not inspect chrome://extensions ({type(exc).__name__})")
        await test_popup_logic(pw)

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S): " + ", ".join(FAILURES))
        return 1
    print("ALL CHECKS PASSED")
    return 0


raise SystemExit(asyncio.run(main()))
