"""End-to-end tests for the CC click and the caption pipeline, in a real browser.

Drives the actual production functions from meet_listener against a synthetic
Meet page, so everything except Google's own DOM is exercised for real:
green room -> mute -> join -> CC button -> injected observer -> exposed binding
-> CaptionSink de-duplication -> printed transcript lines.

Test 2 runs the whole run_meeting() flow, which is what catches errors that only
appear at runtime -- an undefined constant, a bad attribute -- and that neither
py_compile nor a unit test of the pieces would ever surface.

    python tests/test_captions.py
"""
import argparse
import asyncio
import contextlib
import io
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import meet_listener as ml
from playwright.async_api import async_playwright

PAGE = pathlib.Path(__file__).with_name("fake_meet.html").as_uri()
EXPECTED = [
    "Alice Chen: So I think we should ship it",
    "Alice Chen: ...on Friday",
    "Bob Ortiz: Agreed, let's do it",
]
FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        print(f"         got:  {got!r}\n         want: {want!r}")
        FAILURES.append(label)


async def new_page(pw):
    browser = await pw.chromium.launch(
        channel="chrome",
        headless=True,
        args=ml.CHROMIUM_ARGS,
        ignore_default_args=ml.IGNORED_DEFAULT_ARGS,
    )
    ctx = await browser.new_context()
    return browser, ctx, await ctx.new_page()


async def test_caption_pipeline(pw):
    """The CC control and the scraping path, in isolation."""
    print("\nTEST 1 - caption pipeline")
    browser, ctx, page = await new_page(pw)
    await page.goto(PAGE)
    await page.click("#join")  # jump straight into the call

    print("\n1a. Finding the CC toggle among decoy buttons")
    _, label = await ml._find_caption_button(page)
    check("picks 'Turn on captions', not 'Captions settings'/'Caption language'",
          label, "Turn on captions")

    print("\n1b. Confirming the ORIGINAL bug is reproduced by this page")
    try:
        await page.locator("#cc").click(timeout=2000)
        normal = "clicked"
    except Exception:
        normal = "timed out"
    check("a visibility-waiting click fails on the hidden toolbar", normal, "timed out")
    check("...so nothing was toggled by it", await page.evaluate("() => window.__ccClicks"), 0)

    print("\n1c. enable_captions() must succeed anyway, via the JS click")
    check("enable_captions returned True", await ml.enable_captions(page), True)
    check("the button was clicked exactly once",
          await page.evaluate("() => window.__ccClicks"), 1)
    check("aria-label flipped to off-state",
          await page.get_attribute("#cc", "aria-label"), "Turn off captions")

    print("\n1d. Live scraping through the real observer + sink")
    sink = ml.CaptionSink(stable_after=0.6)
    stop = asyncio.Event()
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        await ml.install_caption_observer(ctx, page, sink)
        janitor = asyncio.create_task(sink.janitor(stop))
        await asyncio.sleep(9)
        stop.set()
        janitor.cancel()
        await asyncio.gather(janitor, return_exceptions=True)
        await sink.flush_all()

    lines = [l for l in out.getvalue().splitlines() if l.strip()]
    print("\n   transcript produced:")
    for line in lines:
        print("     ", line)
    check("caption container was located",
          await page.evaluate("() => !!window.__meetCapRootSeen"), True)
    check("transcript lines", [l.split("] ", 1)[1] for l in lines], EXPECTED)

    await ctx.close()
    await browser.close()


async def test_full_run_meeting(pw):
    """The complete join-and-listen flow, exactly as main() drives it."""
    print("\n\nTEST 2 - full run_meeting() flow")
    browser, ctx, page = await new_page(pw)

    args = argparse.Namespace(
        url=PAGE,
        guest=True,
        display_name="BOT1",
        join_timeout=20,
        admit_timeout=20,
        max_minutes=0.25,      # ~15s, then it leaves on its own
        stable_after=0.6,
        alone_grace=0,         # disabled here; test 3 covers the alone path
    )
    sink = ml.CaptionSink(stable_after=0.6)

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = await ml.run_meeting(ctx, args, sink, manage_signals=False)

    lines = [l for l in out.getvalue().splitlines()
             if l.strip() and not l.startswith("---")]
    print("\n   transcript produced:")
    for line in lines:
        print("     ", line)

    check("run_meeting returned success", code, 0)
    check("guest name was entered",
          await page.evaluate("""() => document.querySelector('input[aria-label="Your name"]').value"""),
          "BOT1")
    check("microphone muted via Ctrl+D",
          await page.get_attribute("#mic", "data-is-muted"), "true")
    check("camera muted via the click fallback (Ctrl+E ignored by the page)",
          await page.get_attribute("#cam", "data-is-muted"), "true")
    check("captions were switched on", await page.evaluate("() => window.__ccClicks"), 1)
    check("transcript lines", [l.split("] ", 1)[1] for l in lines], EXPECTED)

    await ctx.close()
    await browser.close()


async def test_leaves_when_alone(pw):
    """Everyone else leaves -> the bot must hang up instead of idling."""
    print("\n\nTEST 3 - leaves an empty meeting")
    browser, ctx, page = await new_page(pw)

    args = argparse.Namespace(
        url=PAGE,
        guest=True,
        display_name="BOT1",
        join_timeout=20,
        admit_timeout=20,
        max_minutes=0,        # no time limit: only the alone-check can end this
        stable_after=0.6,
        alone_grace=3,
    )
    sink = ml.CaptionSink(stable_after=0.6, echo=False)

    started = asyncio.get_event_loop().time()
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            code = await asyncio.wait_for(
                ml.run_meeting(ctx, args, sink, manage_signals=False), timeout=45
            )
        except asyncio.TimeoutError:
            code = "TIMED OUT - never left"
    elapsed = asyncio.get_event_loop().time() - started

    check("run_meeting ended on its own", code, 0)
    check("it hung up rather than idling", elapsed < 40, True)
    body = await page.inner_text("body")
    check("the leave button was actually clicked", "You have left the meeting" in body, True)
    print(f"   (left after {elapsed:.1f}s with no time limit set)")

    await ctx.close()
    await browser.close()


async def test_chat_and_assistant(pw):
    """send_chat_message really types into Meet's chat, and the bot uses it."""
    print("\n\nTEST 4 - chat sending and the wake-word assistant")
    browser, ctx, page = await new_page(pw)
    await page.goto(PAGE)
    await page.click("#join")

    ok = await ml.send_chat_message(page, "hello from the bot")
    check("send_chat_message reported success", ok, True)
    check("the message reached the chat log",
          await page.evaluate("() => window.__sentChat || []"), ["hello from the bot"])

    # Now drive the assistant with a stubbed model, but a REAL chat sender.
    import assistant as mod
    real_ask = mod.ask_ollama

    async def fake_ask(question, url, model, timeout=120.0):
        return f"[{model}] short answer about {question[:30]}"
    mod.ask_ollama = fake_ask
    try:
        bot = mod.Assistant(
            send=lambda text: ml.send_chat_message(page, text),
            ollama_url="http://localhost:11434", model="llama3.2",
            listen_window=2.0, reply_silence=0.5, cooldown=0.2, log=lambda m: None,
        )
        bot.feed({"speaker": "Sanath", "text": "yo bot", "continuation": False})
        await asyncio.sleep(1.0)
        bot.feed({"speaker": "Sanath", "text": "what is docker", "continuation": False})
        await asyncio.sleep(1.0)
        await bot.tick()
        await asyncio.sleep(1.5)

        posted = await page.evaluate("() => window.__sentChat || []")
        check("greeting was posted", posted[1], mod.GREETING)
        check("answer was posted", posted[2].startswith("[llama3.2] short answer"), True)
    finally:
        mod.ask_ollama = real_ask

    await ctx.close()
    await browser.close()


async def main():
    async with async_playwright() as pw:
        await test_caption_pipeline(pw)
        await test_full_run_meeting(pw)
        await test_leaves_when_alone(pw)
        await test_chat_and_assistant(pw)

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S): " + ", ".join(FAILURES))
        return 1
    print("ALL CHECKS PASSED")
    return 0


raise SystemExit(asyncio.run(main()))
