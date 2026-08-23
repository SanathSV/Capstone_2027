#!/usr/bin/env python3
"""
assistant.py -- wake-word assistant that answers in the Meet chat.

Flow:
    1. Somebody says "Astra" or "yo bot" -- spotted in the live captions.
    2. The bot posts a greeting in the meeting chat.
    3. It listens for the next few seconds and collects what is said.
    4. That question goes to a local Ollama model.
    5. The answer is posted back into the chat.

The bot never speaks; everything it says goes into the chat, so it stays out of
the way of the conversation. It only ever reads captions Meet already produced.
"""

from __future__ import annotations

import asyncio
import re
import sys
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

import aiohttp

for _stream in (sys.stdout, sys.stderr):
    # Answers can come back in any script; a legacy console codepage would
    # raise UnicodeEncodeError on the first non-Latin character.
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# "Astra", "yo bot", "yooo bot", "hey bot", "ok astra" and friends.
DEFAULT_WAKE_WORDS = ("astra", "yo bot", "yoo bot", "hey bot", "ok bot")

# What the model is told to do with whatever it hears.
PROMPT_TEMPLATE = (
    "Answer this in simple words. Keep it short enough to read in a chat "
    "message.\n\nQuestion: {question}\n\nAnswer:"
)

# Deliberately odd so it is unmistakably the bot talking, not a person.
# Override with --greeting or MEET_GREETING.
GREETING = "Astra here -- go on, hack around with me. What do you need?"
NOT_HEARD = "I didn't catch a question -- say my name again and ask away."


def build_wake_pattern(words) -> "re.Pattern[str]":
    """Match a wake word as a whole word, tolerating repeated letters.

    People stretch it out -- "yooo bot", "astraaa" -- so each letter is allowed
    to repeat. Word boundaries stop "astra" matching inside a longer word.
    """
    alternatives = []
    for word in words:
        stretched = "".join(
            re.escape(ch) + "+" if ch.isalpha() else re.escape(ch) for ch in word
        )
        alternatives.append(stretched.replace("\\ +", r"\s+").replace(" +", r"\s+"))
    return re.compile(rf"\b({'|'.join(alternatives)})\b", re.I)


async def ask_ollama(question: str, url: str, model: str,
                     timeout: float = 120.0) -> str:
    """Send one question to a local Ollama server and return its answer."""
    payload = {
        "model": model,
        "prompt": PROMPT_TEMPLATE.format(question=question.strip()),
        "stream": False,
        # Keep replies chat-sized rather than essay-sized.
        "options": {"num_predict": 300, "temperature": 0.6},
    }
    endpoint = url.rstrip("/") + "/api/generate"
    async with aiohttp.ClientSession() as session:
        async with session.post(
            endpoint, json=payload, timeout=aiohttp.ClientTimeout(total=timeout)
        ) as response:
            if response.status != 200:
                detail = (await response.text())[:200]
                raise RuntimeError(f"Ollama HTTP {response.status}: {detail}")
            data = await response.json()
    answer = (data.get("response") or "").strip()
    return answer or "(the model returned nothing)"


class Assistant:
    """Wake word -> greet -> listen -> ask the model -> post the answer.

    Fed one finished caption line at a time. `send` posts a chat message and is
    supplied by the caller so this class stays free of any browser code.
    """

    IDLE = "idle"
    LISTENING = "listening"
    THINKING = "thinking"

    def __init__(
        self,
        send: Callable[[str], Awaitable[bool]],
        ollama_url: str,
        model: str = "llama3.2",
        wake_words=DEFAULT_WAKE_WORDS,
        listen_window: float = 20.0,
        reply_silence: float = 4.0,
        cooldown: float = 5.0,
        greeting: str = GREETING,
        log: Callable[[str], None] = print,
        on_state: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.send = send
        self.ollama_url = ollama_url
        self.model = model
        self.pattern = build_wake_pattern(wake_words)
        self.listen_window = listen_window
        self.reply_silence = reply_silence
        self.cooldown = cooldown
        self.greeting = greeting or GREETING
        self.log = log
        # Reported outward so the extension can show that Astra is awake.
        self.on_state = on_state

        self.state = self.IDLE
        self.buffer: List[str] = []
        self.woke_at = 0.0
        self.last_heard = 0.0
        self.quiet_until = 0.0
        self.asker = ""
        self.answered = 0
        self.last_question = ""
        self.last_answer = ""
        self.changed_at = time.time()
        self._task: Optional[asyncio.Task] = None
        self._announce()

    # -- what the UI shows ---------------------------------------------------
    def status(self) -> Dict[str, Any]:
        """A snapshot for the extension: is Astra awake, and on what."""
        labels = {
            self.IDLE: "sleeping - say the wake word",
            self.LISTENING: f"listening to {self.asker or 'you'}...",
            self.THINKING: f"thinking with {self.model}...",
        }
        return {
            "state": self.state,
            "label": labels.get(self.state, self.state),
            "awake": self.state != self.IDLE,
            "asker": self.asker,
            "heard": " ".join(self.buffer).strip(),
            "last_question": self.last_question,
            "last_answer": self.last_answer,
            "answered": self.answered,
            "wake_words": self.pattern.pattern,
            "model": self.model,
            "changed_at": self.changed_at,
        }

    def _announce(self) -> None:
        self.changed_at = time.time()
        if self.on_state:
            try:
                self.on_state(self.status())
            except Exception:
                pass

    # -- input ---------------------------------------------------------------
    def feed(self, record: Dict[str, Any]) -> None:
        """Take one finished caption line. Safe to call from a sync callback."""
        text = (record.get("text") or "").strip()
        if not text:
            return
        speaker = record.get("speaker") or "someone"
        now = time.time()

        if self.state == self.THINKING or now < self.quiet_until:
            return

        if self.state == self.IDLE:
            match = self.pattern.search(text)
            if not match:
                return
            # Anything after the wake word in the same breath is already the
            # question: "Astra, what is a container?" should not need a pause.
            tail = text[match.end():].strip(" ,.:;?!-")
            self.asker = speaker
            self.woke_at = now
            self.last_heard = now
            self.buffer = [tail] if len(tail.split()) >= 3 else []
            self.state = self.LISTENING
            self.log(f"Woken by {speaker}: {match.group(0)!r}")
            self._announce()
            self._spawn(self._greet())
            return

        if self.state == self.LISTENING:
            # Ignore a second wake word while already listening.
            cleaned = self.pattern.sub("", text).strip(" ,.:;-")
            if cleaned:
                self.buffer.append(cleaned)
                self.last_heard = now
                self._announce()

    # -- background timing ---------------------------------------------------
    async def tick(self) -> None:
        """Decide when the speaker has finished asking. Call ~twice a second."""
        if self.state != self.LISTENING:
            return
        now = time.time()
        heard_something = bool(self.buffer)
        silent_for = now - self.last_heard
        expired = now - self.woke_at >= self.listen_window

        if (heard_something and silent_for >= self.reply_silence) or expired:
            question = " ".join(self.buffer).strip()
            self.state = self.THINKING
            self._announce()
            if not question:
                self.log("Woken but nothing was asked.")
                await self.send(NOT_HEARD)
                self._rest()
                return
            await self._answer(question)

    async def _greet(self) -> None:
        await self.send(self.greeting)

    async def _answer(self, question: str) -> None:
        self.log(f"Asking {self.model}: {question[:120]!r}")
        try:
            answer = await ask_ollama(question, self.ollama_url, self.model)
        except asyncio.TimeoutError:
            answer = "Sorry, the local model took too long to answer."
            self.log("Ollama timed out.")
        except Exception as exc:
            answer = "Sorry, I could not reach the local model."
            self.log(f"Ollama failed: {type(exc).__name__}: {exc}")
        else:
            self.log(f"Model answered in {len(answer)} chars.")
        await self.send(answer)
        self.answered += 1
        self.last_question = question
        self.last_answer = answer
        self._rest()

    def _rest(self) -> None:
        """Back to idle, deaf for a moment so the bot cannot retrigger itself."""
        self.state = self.IDLE
        self.buffer = []
        self.quiet_until = time.time() + self.cooldown
        self._announce()

    def _spawn(self, coro: Awaitable[None]) -> None:
        self._task = asyncio.ensure_future(coro)
