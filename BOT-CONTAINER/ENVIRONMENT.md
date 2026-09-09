# Environment Variables & Secrets

Every value `BOT-CONTAINER` reads, where to get it, and what breaks without it.

Copy `.env.example` to `.env` and fill in the three **required** rows. Everything
else has a working default — the container joins a meeting and answers questions
with only those three set.

> `.env` is gitignored, and it must stay that way. `SUPABASE_SERVICE_ROLE_KEY`
> bypasses every row-level-security policy in the database.

---

## 1. Required — the container refuses to start without these

The check runs at boot, before the HTTP server binds, so a missing key is a
startup failure rather than a bot that joins a standup and then cannot answer.

| Variable | Where to get it | Without it |
|---|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → **Data API** → Project URL | Refuses to start |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → **API Keys** → `service_role` (click to reveal) | Refuses to start |
| `GEMINI_API_KEY` | [Google AI Studio → Create API key](https://aistudio.google.com/apikey) | Refuses to start |

**`SUPABASE_URL` must be the bare origin** — `https://abc.supabase.co`, not the
"RESTful endpoint" ending in `/rest/v1`. The client appends its own paths, and
the longer form produces requests to `/rest/v1/rest/v1/meetings` that 404 with
no explanation.

**It must be the service role key, not the anon key.** The container writes
transcripts for meetings it is not a member of and has no user session, so there
is no `auth.uid()` for RLS to match: every insert with the anon key is refused.
The container calls this out explicitly — a key under 40 characters produces a
"looks too short — is that the anon key?" warning at boot, and a `42501` from
Postgres is reported as "this key is probably the anon key" rather than as a
bare permission error.

**Gemini keys are free-tier rate limited** to a few requests per minute. A 429
is reported as such, with that hint attached, rather than as a generic failure.

---

## 2. HTTP

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | The port in the spec. |
| `HOST` | `0.0.0.0` | Must stay `0.0.0.0` **inside Docker**: binding to localhost there means "reachable only from inside the container", so the published port connects to nothing — which looks exactly like a crashed server. |
| `BOT_API_TOKEN` | *(empty)* | Shared secret for `POST /api/start-bot`, accepted as `x-astra-token` **or** `Authorization: Bearer`. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated allow-list, or `*`. |

### Why `ALLOWED_ORIGINS` defaults to `*`

The caller is a Chrome extension. Its origin is `chrome-extension://<install id>`,
and that id differs on every machine the extension is loaded unpacked on — so it
cannot be written into an allow-list in advance. **`BOT_API_TOKEN`, not the
origin, is what protects this endpoint.** Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Put it in `.env` and in `chrome-extension/config.js` as `BOT_API_TOKEN`. Leaving
it empty is defensible only while the port is bound to `127.0.0.1`, which is
what `docker-compose.yml` does; the container warns about it at every boot.

Note what the token is *not*: it is not proof that the caller leads the team.
That check belongs to the dashboard, which has the user's session and the RLS
policies to enforce it. This container trusts whoever holds the secret.

---

## 3. Gemini

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_MODEL` | `gemini-2.0-flash` | A 404 from the API is almost always this being wrong for your key; the error says so. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | Change only for a proxy. |
| `GEMINI_TIMEOUT_MS` | `30000` | A model that takes longer than half a minute has lost the room anyway. |
| `GEMINI_MAX_OUTPUT_TOKENS` | `512` | The answer goes into a chat box, not a document. |

The key travels in the `x-goog-api-key` header rather than as a `?key=` query
parameter, so it cannot end up in an access log.

---

## 4. Browser & joining

| Variable | Default | Notes |
|---|---|---|
| `BOT_HEADLESS` | `1` | **Always `1` in Docker.** A container has no display; `0` fails with a "Missing X server" error that never mentions this setting. `0` on a laptop is the best way to watch a failing join. |
| `BOT_DISPLAY_NAME` | `Astra Notetaker` | Only used for a guest join — a signed-in join carries the Google account's own name. |
| `BOT_USER_AGENT` | a desktop Chrome string | Headless Chromium otherwise advertises `HeadlessChrome`. |
| `BOT_VERIFY_SESSION` | `1` | Probe the Google session before opening the meeting. |
| `BOT_ALLOW_GUEST_FALLBACK` | `1` | Join as a guest when the saved session is refused, instead of failing. |
| `BOT_JOIN_TIMEOUT_MS` | `45000` | How long to hunt for a Join button. |
| `BOT_ADMIT_TIMEOUT_MS` | `300000` | How long to wait in the lobby. |
| `BOT_ALONE_LEAVE_MS` | `120000` | Hang up after this long as the only participant. `0` disables. |
| `BOT_MAX_MEETING_MS` | `14400000` | Hard four-hour ceiling, so a forgotten bot cannot run all week. |
| `BOT_CAPTION_LANGUAGE` | *(empty)* | Meet transcribes the language it is **configured** for; it does not auto-detect. Leaving English set while people speak Telugu produces nonsense, not Telugu. |

### When Google refuses the bot's session

The exported credential is a cookie jar, and two of those cookies —
`__Secure-1PSIDTS` and `__Secure-3PSIDTS` — are **rotation tokens** that Google
reissues continuously as the account is used. Presenting a stale one from a
second browser looks exactly like session hijacking, so Google resolves it the
safe way and invalidates the session.

The result is a credential that dies on its own, with no expiry to check and
nothing wrong with the file: every cookie present, none expired, and Google's
account chooser listing the account with **"Signed out"** beside it.

The container detects this specifically (`src/meet/google.js`) rather than
letting it surface as a missing Join button, and then:

1. reports it in `credential_warning` on the session and on the meeting row,
   naming the fix — **Astra → Settings → Bot Account Setup**;
2. drops the dead cookies and rejoins as a guest, if
   `BOT_ALLOW_GUEST_FALLBACK` is on, so the standup still gets a transcript.

`BOT_VERIFY_SESSION` makes that check happen *before* the meeting is opened, so
nobody in the room watches a bot appear and vanish, and the failure takes about
five seconds instead of the whole join timeout.

---

## 5. Wake word & the 5-second buffer

| Variable | Default | Notes |
|---|---|---|
| `BOT_WAKE_WORDS` | `hey astra,ok astra,astra` | Matched longest-first, so `hey astra` wins and the greeting does not end up inside the question. Word-boundary matched, so "disastrous" does not wake the bot. |
| `BOT_COMPLETION_PHRASES` | `that's all,thats all,that's it,thats it,over to you,thank you astra` | Ends the question immediately. The phrase is stripped before the question is sent. |
| `BOT_SILENCE_MS` | `5000` | The spec's five seconds. |
| `BOT_MIN_QUERY_CHARS` | `3` | A bare "Astra" with nothing after it is somebody saying the name in passing, not a question. |

### The conversation protocol

| Variable | Default | Notes |
|---|---|---|
| `BOT_GREETING` | `Yeah, how can I help you?` | Posted the instant the wake word is heard. |
| `BOT_CONFIRM` | `0` | Read the question back and wait for a spoken yes/no before calling the model. |
| `BOT_HUMOUR` | `1` | Let the bot be dry and occasionally funny, under hard limits. |
| `BOT_CONFIRM_TIMEOUT_MS` | `7000` | How long to wait for that yes/no. Silence means **go ahead**. |
| `BOT_YES_WORDS` | `yes,yeah,yep,…` | Only counted on lines of 8 words or fewer. |
| `BOT_NO_WORDS` | `no,nope,nah,…` | Checked before the yes list. |
| `BOT_REJECTED_REPLY` | `My mistake — …` | Posted when the room says the read-back was wrong. |

```
IDLE ──"Hey Astra"──▶ LISTENING ──5s silence──▶ CONFIRMING ──"yes"──▶ answer
  ▲                       │      or "that's all"    │  │
  │                       │                         │  └──timeout──▶ answer
  └────────"no"───────────┴─────────────────────────┘
```

**The greeting goes out before the question is known.** A bot that says nothing
for eight seconds while somebody talks at it is indistinguishable from one that
did not hear, and people start the question over — which corrupts the buffer
with two overlapping attempts at the same sentence.

**The read-back is off by default, and something better replaced it.** Making
somebody say "yes" out loud to a robot, mid-standup, to unlock an answer is a
worse cure than the disease. Instead the answer *opens* by restating the
question in a handful of words:

> **Since you asked about who has the most commits —** Sanath leads the sprint
> with 6 commits on the Sanath_Dev branch, followed by Souriesh with 4. Not that
> anyone is counting, except for the log.

The room still sees exactly what was heard — so a misheard question is obvious
immediately — but it arrives *with* the answer instead of instead of it.
`BOT_CONFIRM=1` brings the explicit yes/no back for a noisy room.

**On the humour.** The constraints matter more than the permission: it never
comes before the answer, never replaces a fact, never lands on a named person,
and is dropped entirely when somebody is blocked, behind or struggling — they
are in that room reading the chat. `BOT_HUMOUR=0` turns it off wholesale.

**"no" is checked before "yes".** "No, that's wrong" contains a phrase from both
lists, and a mistaken yes costs far more than a mistaken no. Only short lines are
classified at all: "right" is a filler word people say constantly mid-sentence,
and treating a twelve-word sentence containing it as consent would answer
questions nobody agreed to.

Note that the remainder of the wake line is kept as part of the question — "Hey
Astra, why is the PR open?" arrives as one caption. That means filler ("Hey
Astra, have a look") is kept too. The read-back is what makes that visible, and
"no" is what discards it.

`BOT_SILENCE_MS` is measured against **any caption movement, including
mid-sentence rewrites** — not against finalised lines. That distinction is the
whole design: a long sentence takes ten seconds to finalise, and timing from
finalisation alone would cut speakers off mid-question.

---

## 6. In-memory context

| Variable | Default | Notes |
|---|---|---|
| `BOT_MAX_CONTEXT_TURNS` | `12` | Past `[question, answer]` **pairs**. Capped in pairs, not messages: half a turn tells the model what was asked and not what was already answered, so it repeats itself. |
| `BOT_MAX_PRECONTEXT_CHARS` | `24000` | Truncates a runaway briefing rather than letting one request balloon. |

Nothing here is ever read back from Supabase during a live meeting. See the
header comment in `src/context.js` for why.

---

## 7. Chat output

| Variable | Default | Notes |
|---|---|---|
| `BOT_CHAT_CHUNK_CHARS` | `900` | Meet rejects very long chat messages. |
| `BOT_CHAT_MAX_CHUNKS` | `3` | Beyond this the answer is cut with a `[…]` marker — the room should know there was more. |

---

## 8. Operations

| Variable | Default | Notes |
|---|---|---|
| `BOT_MAX_SESSIONS` | `3` | Each session is a real browser. Three is already a lot for a laptop; a 4th summon gets a 429 that says so. |
| `BOT_DATA_DIR` | `data` | Debug screenshots and payload dumps. Mounted as a volume. |
| `BOT_DEBUG_SHOTS` | `1` | Screenshots on a failed join or a failed caption toggle. In a container there is no window to look at, so a picture is the only evidence. |
| `BOT_DEBUG_CAPTIONS` | `1` | If nothing has been heard after 90s, dump the live caption DOM to `data/debug/captions-*.json`. |
| `BOT_CAPTION_DIAGNOSTIC_MS` | `90000` | The grace period before that dump. |
| `BOT_DUMP_PAYLOADS` | `0` | ⚠ Writes the whole summon payload — **including a live Google session** — to `data/payloads/`. Debugging only. |
| `BOT_LOG_TRANSCRIPT` | `1` | Print every finalised caption line (📝) at info level. |
| `BOT_LOG_DB` | `1` | Print a marker (💾) for every Supabase row, with its latency. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug`. `debug` adds interim caption deltas. |
| `TZ` | `UTC` | The browser's timezone, and what timestamps in the log read as. |

---

## 9. What is *not* an environment variable

**The bot's Google session.** It arrives in the request body as
`bot_credentials`, per summon, and is held in memory for the length of that
meeting only. It is never written to `.env`, never written to disk (unless you
deliberately set `BOT_DUMP_PAYLOADS=1`), and never logged — `redact()` in
`src/log.js` reduces it to a state and a count before anything prints.

That is deliberate. One container serves many leaders, and each of them has a
different bot account; a session baked into the image or the environment would
mean one bot identity for everyone and a credential with no expiry sitting in a
config file.

---

## 10. Minimum viable `.env`

```dotenv
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
GEMINI_API_KEY=AIza...
```

Everything else defaults. Add `BOT_API_TOKEN` before the port is reachable by
anything but localhost.
