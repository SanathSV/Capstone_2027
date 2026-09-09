# BOT-CONTAINER

A standalone service that takes a Google Meet link, a sprint briefing and a bot
Google session, and puts a briefed assistant in the meeting: it joins, turns on
captions, writes every finalised line to Supabase, listens for "Hey Astra", and
answers in the in-call chat.

It runs **outside `astra-platform/`** and shares nothing with it but the
database. The dashboard knows who you are and what your sprint looks like; this
container owns a browser and a meeting and knows neither.

```
Chrome extension ──POST /api/start-bot──▶ BOT-CONTAINER ──▶ Google Meet
       │                                       │                  │
       │ reads pre-context + bot session       │ transcripts      │ captions
       ▼                                       ▼                  │
  astra-platform (:3000)                   Supabase ◀─────────────┘
```

---

## Table of contents

1. [Quick start](#1-quick-start)
2. [The database migration](#2-the-database-migration)
3. [Running it](#3-running-it) — development and production
4. [The API](#4-the-api)
5. [Pointing the Chrome extension at it](#5-pointing-the-chrome-extension-at-it)
6. [How it works](#6-how-it-works)
7. [Environment variables](#7-environment-variables)
8. [Troubleshooting](#8-troubleshooting)
9. [**Workflow — zero to a bot in a meeting**](#9-workflow--zero-to-a-bot-in-a-meeting) — start here if you just want to run it

---

## 1. Quick start

```bash
cd BOT-CONTAINER
cp .env.example .env          # fill in the three required values
```

Run the migration in `sql/001_meetings_transcripts.sql` (see below), then:

```bash
docker compose up --build
curl http://localhost:3001/health
```

A healthy container answers:

```json
{ "status": "ok", "service": "astra-bot-container", "supabase": { "ok": true } }
```

`"status": "degraded"` with `Could not find the table 'public.meetings'` means
the migration has not been run. Everything else is working.

---

## 2. The database migration

Open the Supabase SQL Editor, paste **all** of `sql/001_meetings_transcripts.sql`,
run it. It is idempotent and non-destructive — `create table if not exists`,
policies dropped and recreated, no existing row touched — so it is safe on the
live Astra database and safe to run twice.

It creates the hierarchy the spec asks for:

```
teams (id, name)          ← already exists; astra-platform owns it
  └── meetings            ← one row per bot session
        └── transcripts   ← one row per finalised caption line
```

**Two deliberate departures from the spec, both worth knowing about:**

**`teams.team_name` is `teams.name`.** The live table has used `name` since day
one, and astra-platform's dashboard, RLS policies and TypeScript types all read
it. Renaming a column out from under a running application to match a document
is not a trade worth making. The migration ships a view,
`public.meeting_transcripts`, that exposes the spec's spelling for anything that
wants it.

**`meetings.team_id` is nullable, and `meetings.team_ref` is not.** The container
will happily record a meeting for a workspace id that is not one of Astra's
teams. The alternative — inventing a `teams` row — is worse: that table requires
a `leader_id` pointing at a real profile, so the fiction would surface on
somebody's dashboard as a team they lead. `team_ref` always holds the raw
`team_id` from the payload, and `meeting_number` is sequenced against it.

`meeting_number` is assigned by a `BEFORE INSERT` trigger holding a
transaction-scoped advisory lock on the team, not by the application. Computing
`max() + 1` in Node is a race: two bots summoned for the same team in the same
second both read the same maximum.

The last line of the migration is `notify pgrst, 'reload schema'`. PostgREST
caches the schema at boot and does not watch for DDL, so without it a freshly
created table stays invisible to the API — which looks exactly like the
migration never ran.

---

## 3. Running it

### Docker (the normal way)

```bash
docker compose up --build          # foreground, logs to the terminal
docker compose up -d --build       # detached
docker compose logs -f             # follow
docker compose down                # stop; gives sessions 45s to leave calls
```

The compose file sets four things that are not defaults and all of which matter:

- **`shm_size: 1gb`** — Chrome maps a lot of shared memory for its renderers.
  Docker's default `/dev/shm` is 64 MB, and exceeding it makes tabs die with
  "Target closed", the single most common way a containerised Playwright run
  fails mysteriously.
- **`stop_grace_period: 45s`** — a bot in a live call needs time to leave
  properly: flush the caption buffer, drain the transcript queue, write the
  meeting summary. Docker's ten-second default kills it mid-flush.
- **`ports: "127.0.0.1:3001:3001"`** — this endpoint accepts a live Google
  session in its request body. Change the left-hand side only together with
  `BOT_API_TOKEN`.
- **`pids_limit: 512`** — Chromium spawns a process tree; the default is
  reachable across a few concurrent meetings.

### Locally, without Docker

Useful when a join is failing and you want to watch it happen in a real window.

```bash
npm install
npx playwright install chromium     # ~150 MB, once
cp .env.example .env                # fill it in
BOT_HEADLESS=0 LOG_LEVEL=debug npm run dev
```

`BOT_HEADLESS=0` opens a visible browser. `LOG_LEVEL=debug` prints every caption
line as it finalises, which is how you tell "the bot is deaf" from "the room is
quiet".

### The smoke tests

```bash
npm run smoke                        # pure logic: no network, no keys needed
node scripts/smoke.js --browser      # + the caption observer in a real Chromium
                                     #   against a synthetic Meet DOM
node scripts/popup-ui-test.mjs       # + the extension popup, chrome.* stubbed
node scripts/google-gate-test.mjs    # + the Google gate, against the real
                                     #   accounts.google.com
node scripts/fixture-test.mjs        # + the caption observer against
                                     #   Meeting_Bot's Meet replica
node scripts/pipeline-demo.mjs       # + captions -> Supabase, live, then cleans up
node scripts/conversation-demo.mjs   # + the wake/confirm/answer loop, live Gemini
```

`fixture-test.mjs` is the one to reach for when captions look broken. It runs the
observer against `Meeting_Bot/tests/fake_meet.html` — a replica of Meet's caption
DOM *and* its behaviour, including the auto-hiding toolbar — driven by this
container's own `clickJoin` / `enableCaptions` / observer rather than by
shortcuts. That fixture backed a Python scraper which produced real transcripts
with real speaker names, so it is a known-good reference rather than another
guess:

```
  transcript as the container would record it:
    Alice Chen » So I think we should ship it on Friday
    Bob Ortiz  » Agreed, let's do it
```

**If that passes and a real meeting still produces nothing, the observer is
fine and the captions were never on.** Check the log for `captions enabled
via…`; a failure there is now logged at error level and posted into the meeting
chat, because Meet's CC toggle is per-participant and nobody else in the room
can switch it on for the bot.

86 checks in total, aimed at the parts that fail in ways nobody notices until a
standup: where a question starts and stops, what the room actually sees in the
chat panel, whether a caption block is finalised exactly once, and whether the
popup can be tricked into summoning a second bot into a room that has one.

`google-gate-test.mjs` is deliberately **not** mocked. The whole value of that
module is that it reads a page Google renders and versions on its own schedule,
so a fixture would only test the fixture. It navigates once, to a page belonging
to the bot's own account, and touches no meeting. It asserts the shape of the
answer rather than a verdict — both "the session is live" and "the session is
dead, and the reason says to re-authenticate" pass, because demanding either one
would make the suite fail the day somebody re-authenticated.

### Production notes

Nothing here is stateful, so scaling out is just more containers — but **each
session is a real headless Chrome**, so the limit is memory, not CPU. Budget
roughly 500 MB–1 GB per concurrent meeting and set `BOT_MAX_SESSIONS`
accordingly; a summon past the limit gets a 429 that says which limit it hit.

Before exposing the port beyond localhost:

1. Set `BOT_API_TOKEN` (and the matching value in the extension).
2. Put TLS in front of it. The payload contains a live Google session.
3. Set `ALLOWED_ORIGINS` to something narrower than `*` if the callers are known.
4. Leave `BOT_DUMP_PAYLOADS=0`.

---

## 4. The API

### `POST /api/start-bot`

```jsonc
{
  "team_id":     "d2675e94-d9a8-4ede-aede-0fa107c52558",
  "meet_link":   "https://meet.google.com/okf-dwkm-ydu",
  "pre_context": "# Astra_dev\n**Leader:** …",     // Markdown string
  "bot_credentials": { "cookies": [ /* … */ ], "origins": [] }
}
```

Returns **202**, not 200:

```jsonc
{
  "status": "accepted",
  "message": "Astra is joining https://meet.google.com/okf-dwkm-ydu.",
  "session_id": "9f3c…",
  "meeting": { "id": "…", "number": 7 },
  "poll": "/api/sessions/9f3c…"
}
```

A meeting lasts as long as a meeting lasts. Holding the connection open for it
would time out at every proxy between the extension and here, and the caller
would be told the bot failed while it sat happily in the call. So the request
does only the work that can fail *quickly and usefully* — validate the payload,
resolve the team, open the meeting row — and everything after runs detached.

**Payload handling is loose in one direction and strict in the other.** Unknown
fields are ignored silently (the log names them); the four core fields are
enforced. `meetLink`, `meet_link` and `url` all work. That asymmetry is
deliberate: the extension will grow fields, and a container that 400s on an
unknown key breaks every time the sender ships first.

`bot_credentials` accepts either shape:

| Shape | What happens |
|---|---|
| `{cookies: [...], origins: [...]}` | Launches pre-authenticated. **This is the path that works.** |
| `{email, password}` | Attempts a scripted Google sign-in. See the warning below. |
| absent / unusable | Joins as a guest named `BOT_DISPLAY_NAME` and needs admitting. |

> **On email/password.** The spec asks for it and it is implemented, but Google
> actively resists automated password sign-in: a headless Chromium driving
> `accounts.google.com` routinely hits "This browser or app may not be secure", a
> device-verification challenge, or 2FA — none of which a container can answer.
> It works most reliably on a dedicated account with 2FA off and a prior
> successful sign-in from the same IP, and it can start failing with no change on
> our side. The exported-session path is what Astra's dashboard already produces
> from a real human sign-in, and it is what you should use. When both are
> present, cookies win. Failures on this path report exactly what Google said
> rather than pretending.

### Other endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness, Supabase reachability, session counts. |
| `GET` | `/api/sessions` | Every session this container knows about. |
| `GET` | `/api/sessions/:id` | One session: status, counts, queue depth. |
| `POST` | `/api/sessions/:id/stop` | Make the bot leave, cleanly. |

Auth: if `BOT_API_TOKEN` is set, send it as `x-astra-token` or
`Authorization: Bearer`. Both are accepted so the Supabase access token and the
container's own secret can travel on the same request.

---

## 5. Pointing the Chrome extension at it

Already done in `astra-platform/chrome-extension`. What changed:

- `config.js` gained `BOT_API_BASE` (`http://localhost:3001`),
  `BOT_DISPATCH_PATH` and `BOT_API_TOKEN`.
- `lib/api.js` gained `dispatchBot()`, which POSTs to the container.
- `popup.js` calls it instead of the dashboard's `/api/bot/summon`.
- `manifest.json` lists `http://localhost:3001/*` in `host_permissions` —
  Chrome blocks any host not listed there, with a CORS-shaped error that never
  mentions the manifest.

**The extension still reads from the dashboard.** Teams, pre-context and the
leader's bot session all come from `:3000`; only the dispatch moved. So both
have to be running.

If you set `BOT_API_TOKEN` in `.env`, set the same string in `config.js`.

The dashboard's `/api/bot/summon` is left in place. It is no longer what the
button calls, but it authenticates the caller, checks leadership against the
database and writes the request to `_sent_data_extension/` — a useful capture
point while this is all still being wired up.

---

## 6. How it works

```
Meet DOM ──delta──▶ WakeWordDetector.activity()      resets the 5s window
         └─final──▶ FIFO queue ──▶ Supabase          durable, in order
                 └▶ WakeWordDetector.feed()          wake word + buffering
                                  │
                            onQuery │  5s silence, or "that's all"
                                  ▼
                     answer queue ──▶ Gemini ──▶ Meet chat
                                  └▶ SessionContext.remember()
```

### Caption capture — element-addition delta

Meet does not emit finished sentences. It renders a caption block per utterance
and rewrites it in place: `"so I"` → `"so I think"` → `"so I think we should
ship it"`. When the speaker stops, Meet **appends a new sibling element** and
never touches the old block again.

That gives an exact finalisation signal that needs no timer:

> A caption block is final the moment a newer block element appears after it —
> or the moment it leaves the caption region.

**That rule alone is not enough, and the gap is not a corner case.** Meet only
starts a new block when the **speaker changes**. While one person holds the
floor, everything accumulates in a single block that grows for as long as they
talk — so no new element ever appears, nothing is finalised, and a ten-minute
monologue arrives as one enormous line when the bot leaves. A real meeting
produced exactly one transcript row reading *"All right. Uh, I suppose you guys
can hear me right now. Got it. Uh. Let's, uh, firstly begin with…"*.

So there is a second rule: a block that has sat **unchanged for
`BOT_CAPTION_SETTLE_MS`** (2s) emits the part of itself not yet sent, and stays
tracked. The pauses a speaker leaves between sentences are what turn a monologue
into lines. Continuations carry only the new words, marked `continuation: true`,
so nothing is written twice.

Emission latency is the settle time plus one 400ms poll — about 2.5s after a
speaker pauses.

A `MutationObserver` with `childList: true` on the caption container watches for
exactly that. It is strictly better than "emit a block once it has been quiet
for N seconds": a timer either truncates slow speakers (N too small) or delays
every line by N (N too large). The DOM already knows the answer.

Two message types come back to Node. `final` is a real utterance — it goes to
the database and the detector. `delta` is an in-place rewrite; it is never
persisted and never sent to the model, and its only job is to prove somebody is
still mid-sentence.

### The FIFO queue

Caption blocks finalise in bursts — three people talking over each other
produces three finalised lines in a few hundred milliseconds. Three concurrent
inserts complete in any order, and `created_at` defaults are microsecond-close,
so the transcript comes back interleaved wrongly. A transcript whose lines are
out of order is not a transcript. One task in flight, in order; a failing task
is logged and skipped rather than stalling everything behind it.

### The conversation protocol

```
IDLE ──"Hey Astra"──▶ LISTENING ──5s silence──▶ CONFIRMING ──"yes"──▶ answer
  ▲                       │      or "that's all"    │  │
  │                       │                         │  └──timeout──▶ answer
  └────────"no"───────────┴─────────────────────────┘
```

The greeting is posted the moment the name is heard, before anyone knows what
the question is — a bot that stays silent for eight seconds while somebody talks
at it is indistinguishable from one that did not hear, and they start over. The
question is then read back and a yes/no awaited, because captions mishear names
and jargon constantly and an answer to a misheard question is worse than none:
it is confidently wrong in front of the room. Silence during confirmation means
proceed; only an explicit "no" throws the question away.

`node scripts/conversation-demo.mjs` runs the whole loop with a live Gemini call
and prints what the meeting chat would show.

### Wake word and the 5-second buffer

The wake word is matched **only on finalised text**. Matching interim text would
fire on `"hey ast"` and then again on `"hey astra"`, asking the model the same
question twice.

A question ends on either of two signals: five seconds during which the caption
region did not change *at all* (interim updates included — this is what `delta`
is for), or a trailing completion phrase like "that's all", which ends it
immediately because making someone who has explicitly finished wait five more
seconds feels broken.

### In-memory context, and the no-reads rule

The container never queries Supabase during a live meeting. Reading transcript
history back to build a prompt would put a round-trip between someone finishing
a question and the bot answering, it costs a query per question, and it grows
with meeting length — so the bot gets slower exactly as the standup drags on.

The last twelve `[question, answer]` **pairs** live in a local array instead.
Capped in pairs, not messages: half a turn tells the model what was asked and
not what was already answered, and it will repeat itself. The full transcript
still goes to Supabase line by line — that table is the record, this array is
the working set.

### The chat answer

An LLM returns markdown; Meet's chat renders none of it, so the room would see
literal asterisks. Worse: **in Meet's chat box, Enter sends**. A multi-line
answer typed straight in produces one message per line, each fired the instant a
newline is typed, spraying half-sentences into the meeting. So the answer is
stripped of markup, split at sentence boundaries into at most three whole
messages, and sent in order — each its own bubble, which reads better in a
narrow panel than one wall of text.

### Announcing itself

The bot posts a line in the chat when it joins. Not decoration: a bot that
transcribes a meeting without telling anyone is a consent problem, and the room
has no other way to learn the wake word.

---

## 7. Environment variables

The complete list, with sources and failure modes, is in
**[ENVIRONMENT.md](./ENVIRONMENT.md)**. The three that are required:

```dotenv
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
GEMINI_API_KEY=AIza...
```

The container refuses to start without them — deliberately, so a missing key is
a startup failure rather than a bot that joins a standup and then cannot answer.

---

## 8. Troubleshooting

**`Could not find the table 'public.meetings' in the schema cache`**
The migration has not been run, or PostgREST has not reloaded. Run
`sql/001_meetings_transcripts.sql` and give it a few seconds.

**`permission denied` / error code 42501**
That is the anon key, not the `service_role` key.

**Watching what the bot is hearing**

Ask it, rather than grepping:

```bash
curl "http://localhost:3001/api/transcript?format=text"
```

```
02:41:19  speech   Ravi           » morning everyone, the deploy went out at seven
02:41:20  speech   Sam            » Hey Astra
02:41:22  question Sam            » who has the most commits this sprint
02:41:24  answer   Astra          » Sanath has the most commits this sprint with six…
```

An empty one says which of the two possible reasons it is:

```
no captions yet — status=in_call, captions_enabled=true
```

`captions_enabled=true` and no lines means the room is quiet. `false` means the
bot could not switch its own CC on and never will hear anything — Meet's toggle
is per-participant, so nobody else can do it for it.

> **Why not just `docker compose logs -f | grep 📝`?** Because `grep`
> block-buffers when its stdout is a pipe rather than a terminal, so it sits
> silent until ~4KB of *matching* output has piled up. A quiet standup never
> gets there, and the bot looks broken when it is not. Use
> `grep --line-buffered` if you want to follow the log that way.

**Reading the log**

Two markers make the interesting lines greppable out of a busy meeting:

```bash
# --line-buffered is NOT optional with -f: without it grep waits for ~4KB of
# matches before printing anything, and a quiet meeting never reaches that.
docker compose logs -f | grep --line-buffered -E "📝|💬"   # the conversation
docker compose logs -f | grep --line-buffered 💾           # Supabase writes
docker compose logs   | grep "💾.*✗"                       # writes that FAILED
docker compose logs -f | grep --line-buffered 🧠           # model calls
```

A meeting looks like this:

```
💾 supabase.meetings ✓ insert #9 (24fdd024-…) for Astra_dev
📝 #1   speech   Ravi           » morning everyone, the deploy went out at seven
💾 supabase.transcripts ✓ #1 speech · 185ms
📝 #4   speech   Sam            » Hey Astra
💬 Yeah, how can I help you?
📝 #5   speech   Sam            » who has the most commits this sprint
💾 supabase.transcripts ✓ #5 speech · 134ms
📝 #7   question Sam            » who has the most commits this sprint
🧠 gemini ← 1962ms · gemini-flash-latest · prompt ~477 tokens
📝 #8   answer   Astra          » Sanath has the most commits this sprint with 6…
💾 supabase.transcripts ✓ #8 answer · 157ms
💾 supabase totals: 8 row(s) written, 0 failed · meeting 24fdd024-…
```

The `#N` on a 📝 line and the `#N` on its 💾 line are the same row, so the two
can be matched by eye. They are **separate events on purpose**: a line is heard
at one moment and stored at another — the queue serialises writes, so under load
there is real lag between them — and collapsing them into one line after the
fact would hide exactly the delay you would be debugging.

A failed write is logged at error level whatever `BOT_LOG_DB` says: a silently
dropped row is the one failure that leaves no trace anywhere else.

`node scripts/pipeline-demo.mjs` runs the whole caption → transcript → Supabase
path with real inserts and a real Gemini call, reads the rows back to prove they
landed, and deletes them again (`--keep` to leave them).

**The transcript contains interface text ("Jump to bottom", "Turn on captions")**
Google rotated its caption class names, the text selectors stopped matching, and
the structural fallback scraped the buttons Meet puts *inside* the captions
region. Fixed: the observer now picks the innermost caption container and
excludes anything clickable or `aria-hidden`. If new interface text still shows
up, run with `BOT_DEBUG_CAPTIONS=1` and read `data/debug/captions-*.json` — it
contains the live DOM, and `TEXT_SELECTORS` in `src/meet/captions.js` can be
updated from what is actually there rather than guessed at.

**The bot joins but the transcript is empty**
Captions are not on. Run with `LOG_LEVEL=debug` and look for "captions enabled
via…". If it says "no caption button found by accessible name", the log lists
every ARIA label on the toolbar — Meet has moved the control, usually into the
overflow menu on a narrow window. A screenshot is in `data/debug/`.

**The bot gets stuck on a Google "Choose an account" screen, or the log says
"Google has invalidated the bot's saved session"**
The exported session is dead. This happens on its own: `__Secure-1PSIDTS` is a
rotation token Google reissues as the account is used, and a stale copy in a
second browser gets the whole session invalidated. Every cookie will still be
present and unexpired — that is not the problem. **Re-authenticate at Astra →
Settings → Bot Account Setup.** Until then the bot joins as a guest (see
`BOT_ALLOW_GUEST_FALLBACK`) and has to be admitted by hand.

**The bot never gets in**
Check `data/debug/` for a screenshot. A guest join needs a human to admit it;
`BOT_ADMIT_TIMEOUT_MS` is how long it waits.

**`Executable doesn't exist at /ms-playwright/chromium-…`**
The `playwright` version in `package.json` and the Playwright base image tag in
the `Dockerfile` have drifted apart. They must match exactly.

**Chrome tabs die with "Target closed"**
`/dev/shm` is too small. `shm_size: 1gb` is already in `docker-compose.yml`; if
you are running `docker run` by hand, pass `--shm-size=1g`.

**`Node.js detected but native WebSocket not found`**
`createClient()` builds a RealtimeClient eagerly, and that throws when the
runtime has no global `WebSocket` — which only exists from Node 22, while the
Playwright base image ships Node 20. `src/db.js` hands realtime a transport it
never instantiates, so the Node version does not matter; if this ever comes
back, that is the line that was removed. The container uses no subscriptions.

**"Never found a Join button"**
Since the Google gate check landed this means what it says — a wrong link, or a
meeting that has not started. It is no longer what a dead credential looks like;
that reports itself.

**Gemini 404**
`GEMINI_MODEL` is not available for that key. Try `gemini-2.0-flash`.

**Gemini 429 / 503**
Rate limit, or "this model is currently experiencing high demand". Both are
retried twice with backoff before the bot gives up, which turns nearly all of
them into an answer.

**The answer stops mid-sentence**
Reasoning tokens are billed against the same output budget as the answer, so a
thinking model deliberates for 500 tokens and gets cut off. The container sends
`thinkingConfig: { thinkingBudget: 0 }` to prevent that; if you have pinned a
model that rejects the field, raise `GEMINI_MAX_OUTPUT_TOKENS` instead.

**The extension says "Could not reach the bot container"**
Either it is not running, or `http://localhost:3001/*` is missing from
`host_permissions` in the extension's `manifest.json`. Chrome reports the second
as a CORS error that never mentions the manifest.

---

## Layout

```
BOT-CONTAINER/
├── src/
│   ├── server.js      Express: /api/start-bot, /api/sessions, /health
│   ├── session.js     one meeting, start to hang-up
│   ├── payload.js     the four core parameters; ignores the rest
│   ├── wake.js        wake word + the 5-second silence buffer
│   ├── context.js     the in-memory [Q, A] window
│   ├── llm.js         Gemini, over plain fetch
│   ├── db.js          teams → meetings → transcripts (writes only)
│   ├── queue.js       the single-threaded FIFO
│   ├── config.js      every knob, validated at boot
│   ├── log.js         logging, with credential redaction
│   └── meet/
│       ├── browser.js   launch args, storage state, password sign-in
│       ├── join.js      join, mute, captions, participant count, leave
│       ├── captions.js  the element-addition delta observer
│       └── chat.js      markdown → readable chat messages
├── sql/001_meetings_transcripts.sql
├── scripts/smoke.js
├── Dockerfile · docker-compose.yml · .env.example
└── ENVIRONMENT.md
```

---

## 9. Workflow — zero to a bot in a meeting

The end-to-end path, in the order you actually do it. Sections 1–8 above explain
*why* each piece is the way it is; this one is just the sequence.

### Step 0 — what you supply, and what you do not

**You supply two things: Supabase and Gemini.** That is the whole list.

**The bot's Google session is not one of them.** It is not in `.env`, there is no
field for it in `.env.example`, and there is nothing to paste. It arrives in the
body of each summon, from the Chrome extension, which reads it from the
dashboard's `/api/bot-auth/session` — which in turn reads the `auth.json` your
own headful sign-in produced under **Settings → Bot Account Setup**.

That is deliberate rather than incidental. One container serves many leaders, and
each of them has a different bot account; a session baked into the image or the
environment would mean one bot identity for everyone, and a credential with no
expiry sitting in a config file. So it is held in memory for the length of one
meeting, never written to disk, and never logged — `redact()` in `src/log.js`
reduces it to a state and a count before anything prints.

### Step 1 — fill in `.env`

```bash
cd BOT-CONTAINER
cp .env.example .env
```

| Value | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase → Settings → **Data API** → Project URL. The bare origin, no `/rest/v1`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → **API Keys** → `service_role` (click to reveal). **Not** the anon key. |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → Create API key |

The first two already exist in `astra-platform/.env.local` — copy them across.
Everything else in the file has a working default.

### Step 2 — run the migration

Paste all of `sql/001_meetings_transcripts.sql` into the Supabase SQL editor and
run it. Nothing works before this. It is idempotent and touches no existing row.

### Step 3 — start both services

Two terminals. The extension **reads** from the dashboard and **dispatches** to
the container, so both have to be up.

```bash
# terminal 1 — the dashboard, for teams / pre-context / bot session
cd astra-platform && npm run dev

# terminal 2 — the bot
cd BOT-CONTAINER && docker compose up --build
```

Without Docker — better while you are still debugging a join:

```bash
npm install && npx playwright install chromium
BOT_HEADLESS=0 LOG_LEVEL=debug npm run dev
```

`BOT_HEADLESS=0` opens a real window so you can watch it join. `LOG_LEVEL=debug`
prints every caption line as it finalises, which is how you tell "the bot is
deaf" from "the room is quiet".

Confirm: `curl http://localhost:3001/health` → `"status": "ok"`. A `degraded`
with `Could not find the table 'public.meetings'` means step 2 has not been done.

### Step 4 — match the token, if you set one

If `BOT_API_TOKEN` is set in `.env`, put the identical string in
`chrome-extension/config.js`. A mismatch gives a 401 that says so. Both empty is
fine while the port is bound to localhost.

### Step 5 — click Connect Bot

Open a Google Meet tab, open the extension, pick the team, click **Connect Bot**.

1. The extension POSTs `{team_id, meet_link, pre_context, bot_credentials}` to
   `http://localhost:3001/api/start-bot`.
2. The container validates, resolves the team, opens the meeting row, and returns
   **202** with a `session_id`. It does not wait for the meeting — see §4.
3. The popup says *"Astra is joining… Meeting #1. Admit it from the meeting if it
   is waiting in the lobby."*
4. The browser launches with your cookies, joins, mutes mic and camera, turns on
   captions, and posts a hello line in the chat naming the wake word.
5. Say **"Hey Astra, …"**. It buffers until five seconds of silence or a phrase
   like "that's all", then answers in the chat.

Watch it live:

```bash
curl http://localhost:3001/api/sessions/<session_id>   # status, counts, queue depth
docker compose logs -f                                  # or the dev terminal
```

### Where the prompt lives

Two pieces, both in `src/llm.js`:

- **`SYSTEM_INSTRUCTION`** (line 29) — the standing rules: lead with the answer,
  three sentences or fewer, no markdown, never invent a PR number or issue key.
- **`assemblePrompt()`** (line 60) — stitches the three sources together.

Assembly is a pure function, kept separate from the network call, so the exact
string sent to the model can be printed, diffed and eyeballed without spending a
token. **If an answer is wrong, this string is the first place to look.**

```
# Sprint context — Astra_dev
# Astra_dev
**Leader:** kalpanabandi1982
## Agenda
1. Moving: Sanath (6 commit(s)); Souriesh (4 commit(s)); Abhiram Bobba (1 commit(s)).
## Team
| Person | Role | Commits | PRs | Reviews | Doing | Done |
|---|---|---|---|---|---|---|
| Sanath | Team Leader | 6 | — | — | — | — |
        … the rest of the pre-context markdown from the payload …
_Generated 2026-09-08T15:29:44.576Z · Astra pre-context._

# Already answered in this meeting
Q: what is blocking the release
A: PR 41 is waiting on review from Sanath.

# The question just asked
Ravi asked: and what about his other one
```

Three sources, in that order: the **static pre-context** from the payload, the
**in-memory Q&A window** (last `BOT_MAX_CONTEXT_TURNS` pairs, never read back
from Supabase), and the **current question** from the 5-second buffer. The middle
block is what makes a follow-up like "his other one" resolvable at all.

To print it yourself for a given payload:

```bash
node -e "import('./src/llm.js').then(({assemblePrompt}) => console.log(
  assemblePrompt({ preContext: 'PASTE MARKDOWN', history: [], query: 'test', speaker: 'You' })))"
```
