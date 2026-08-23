"""Tests for the wake-word assistant.

The state machine runs against a fake chat sender, so no browser is needed.
The Ollama check is skipped automatically when no server is running.

    python tests/test_assistant.py
"""
import asyncio
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from assistant import GREETING, Assistant, ask_ollama, build_wake_pattern  # noqa: E402

OLLAMA = "http://localhost:11434"
FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        print(f"         got:  {got!r}\n         want: {want!r}")
        FAILURES.append(label)


def ollama_up() -> bool:
    try:
        urllib.request.urlopen(OLLAMA + "/api/tags", timeout=3).read()
        return True
    except (urllib.error.URLError, OSError):
        return False


def make_bot(sent, **kw):
    async def send(text):
        sent.append(text)
        return True
    defaults = dict(ollama_url=OLLAMA, model="llama3.2", listen_window=2.0,
                    reply_silence=0.5, cooldown=0.2, log=lambda m: None)
    defaults.update(kw)
    return Assistant(send=send, **defaults)


def line(speaker, text):
    return {"speaker": speaker, "text": text, "continuation": False}


async def test_wake_pattern():
    print("\n1. Wake word matching")
    pattern = build_wake_pattern(("astra", "yo bot"))
    for text, expected in [
        ("Astra are you there", True),
        ("yo bot help me", True),
        ("yooooo bot", True),          # stretched vowels
        ("astraaa", True),
        ("ASTRA", True),
        ("the orchestra played", False),   # not inside another word
        ("robot uprising", False),
        ("nothing to see", False),
    ]:
        check(f"{text!r}", bool(pattern.search(text)), expected)


async def test_greets_then_answers(monkey_answer="Python is a programming language."):
    print("\n2. Wake -> greet -> listen -> answer")
    sent = []
    bot = make_bot(sent)

    async def fake_ask(question, url, model, timeout=120.0):
        fake_ask.asked = question
        return monkey_answer
    import assistant as mod
    mod.ask_ollama, real = fake_ask, mod.ask_ollama
    try:
        bot.feed(line("Sanath", "hey astra"))
        await asyncio.sleep(0.1)
        check("greeted immediately", sent, [GREETING])
        check("now listening", bot.state, Assistant.LISTENING)

        bot.feed(line("Sanath", "what is python"))
        await bot.tick()
        check("still listening while they talk", bot.state, Assistant.LISTENING)

        await asyncio.sleep(0.6)          # longer than reply_silence
        await bot.tick()
        await asyncio.sleep(0.2)
        check("question captured", getattr(fake_ask, "asked", ""), "what is python")
        check("answer posted to chat", sent[-1], monkey_answer)
        check("back to idle", bot.state, Assistant.IDLE)
    finally:
        mod.ask_ollama = real


async def test_question_in_same_breath():
    print("\n3. Question asked in the same sentence as the wake word")
    sent = []
    bot = make_bot(sent)
    import assistant as mod
    captured = {}

    async def fake_ask(question, url, model, timeout=120.0):
        captured["q"] = question
        return "ok"
    mod.ask_ollama, real = fake_ask, mod.ask_ollama
    try:
        bot.feed(line("Sanath", "Astra, what is a container?"))
        await asyncio.sleep(0.1)
        await asyncio.sleep(0.6)
        await bot.tick()
        await asyncio.sleep(0.2)
        check("kept the trailing question", captured.get("q"), "what is a container")
    finally:
        mod.ask_ollama = real


async def test_ignores_chatter_and_timeout():
    print("\n4. Not woken by ordinary talk; gives up when nothing is asked")
    sent = []
    bot = make_bot(sent)
    bot.feed(line("Sanath", "so anyway the deadline is friday"))
    await bot.tick()
    check("stayed idle", bot.state, Assistant.IDLE)
    check("said nothing", sent, [])

    bot.feed(line("Sanath", "astra"))
    await asyncio.sleep(0.1)
    await asyncio.sleep(2.1)              # past listen_window with no question
    await bot.tick()
    await asyncio.sleep(0.1)
    check("prompted for a question", sent[-1].startswith("I didn't catch"), True)
    check("returned to idle", bot.state, Assistant.IDLE)


async def test_real_ollama():
    print("\n5. Real Ollama call (llama3.2)")
    if not ollama_up():
        print("  [SKIP] no Ollama server on localhost:11434")
        return
    started = time.time()
    answer = await ask_ollama("what is 2 plus 2", OLLAMA, "llama3.2", timeout=90)
    elapsed = time.time() - started
    print(f"  model said: {answer[:120]!r}")
    check("got a non-empty answer", bool(answer.strip()), True)
    check("answer is chat-sized", len(answer) < 2000, True)
    print(f"  (took {elapsed:.1f}s)")


async def main():
    await test_wake_pattern()
    await test_greets_then_answers()
    await test_question_in_same_breath()
    await test_ignores_chatter_and_timeout()
    await test_real_ollama()

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S): " + ", ".join(FAILURES))
        return 1
    print("ALL CHECKS PASSED")
    return 0


raise SystemExit(asyncio.run(main()))
