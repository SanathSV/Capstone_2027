# How to run it

A bot that joins a Google Meet, captures the captions, and answers questions in
the chat when you say its wake word.

Design and API: [ARCHITECTURE.md](ARCHITECTURE.md). What each file does:
[FILES.md](FILES.md). Why the keys exist: [SECURITY.md](SECURITY.md).

**New here? Read [First-time setup](#first-time-setup) once, then live in
[Every time](#every-time).** Everything you need is your own — your own Google
login, your own keys. Nothing is shared, and nothing secret is in this repo.

---

## Prerequisites

| Thing | Why | Check |
|---|---|---|
| Python 3.10+ | runs the bot and the helper scripts | `python --version` |
| Docker Desktop | runs the bot in a container | `docker --version` |
| Google Chrome | Meet degrades its features for other browsers | — |
| A Google account | the bot joins the meeting *as* this account | — |
| Ollama *(optional)* | the in-meeting assistant's brain | `ollama --version` |

Windows, macOS and Linux all work. Commands below are given for PowerShell
first; the bash equivalent follows where they differ.

---

## First-time setup

Do this once per machine. It takes about ten minutes, most of it downloads.

### 1. Clone and enter the project

    git clone <repo-url>
    cd Capstone_2027/Meeting_Bot

### 2. Create a virtual environment

PowerShell:

    python -m venv .venv
    .\.venv\Scripts\Activate.ps1

bash / zsh:

    python3 -m venv .venv
    source .venv/bin/activate

If PowerShell blocks the activate script:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### 3. Install dependencies

    pip install -r requirements.txt
    playwright install chrome

The second line lets Playwright drive your real Chrome. If it fails, the bot
falls back to bundled Chromium — usable, but Meet gives it fewer features.

### 4. Make your own `.env`

PowerShell:

    Copy-Item .env.example .env

bash / zsh:

    cp .env.example .env

Open `.env` and replace the two placeholder keys with anything long and random.
**They are yours alone** — they do not have to match anyone else's, they only
have to match between your own terminals. `.env` is gitignored.

`docker compose` reads `.env` on its own. Your terminal does not, so either
pass `--key` to `tester.py` every time, or load the file into your shell:

PowerShell:

    Get-Content .env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
        $n, $v = $_ -split '=', 2; Set-Item "env:$($n.Trim())" $v.Trim() }

bash / zsh:

    set -a; . ./.env; set +a

### 5. Log in to Google — your own account, your own `creds/`

    python meet_listener.py --login --profile ./creds

Sign in in the window that opens. Wait for `Signed in.` and
`Exported NN Google cookie(s)`.

`creds/` is a signed-in Chrome profile: whoever holds that folder *is* logged
in as you. It is gitignored and it must stay that way — never copy it to a
teammate, never paste it into chat, never commit it. Each person runs this step
with their own account. Details in [SECURITY.md](SECURITY.md).

---

## Every time

### Step 1 — Open Docker Desktop

Wait until it says **Engine running**.

### Step 2 — Start the transcript receiver

    python host_listener.py --port 9000 --key <your MEET_CALLBACK_KEY>

Leave this terminal open. Transcripts appear here and in `.\transcripts\`.

### Step 3 — Start the container

New terminal, in the project folder:

    docker compose up -d --build

Compose picks your keys up from `.env`. First build pulls a large Playwright
image; later builds are quick.

### Step 4 — Check it

    python tester.py health --key $env:MEET_API_KEY

Must show `credentials : present`. (bash: `--key "$MEET_API_KEY"`.)

### Step 5 — Send the bot in

    python tester.py join "https://meet.google.com/xjo-ycwh-rao" --key $env:MEET_API_KEY

### Step 6 — Admit it

Click **Admit** in the meeting. The transcript then streams into the Step 2
terminal.

### Step 7 — Stop

    python tester.py list --key $env:MEET_API_KEY
    python tester.py leave <session_id> --key $env:MEET_API_KEY
    docker compose down

---

## Talking to the bot in the meeting

Say **"Astra"** or **"yo bot"** out loud. The bot posts
`wts upp ?? how can i help you` in the chat, listens for your question, asks
your local Ollama, and posts the answer in the chat.

Needs Ollama running on your machine (`ollama serve`, model `llama3.2`).
It is on by default in the container. Locally:

    python meet_listener.py --url <link> --assistant

The **extension popup shows Astra live** while it happens: a grey dot when
asleep, a pulsing blue dot with `Astra: LISTENING` the moment it hears its name,
amber `THINKING` while the model runs, then the question and answer.

Tuning: `--wake-words`, `--greeting`, `--ollama-model`, `--listen-window`,
`--reply-silence`. In the container the same settings are `MEET_WAKE_WORDS`,
`MEET_GREETING`, `MEET_OLLAMA_MODEL` — set them in your `.env`.

---

## Without Docker

    python meet_listener.py --url https://meet.google.com/abc-defg-hij

Do not run this while the container is up — both use `./creds`, and Chrome
allows only one browser per profile.

---

## Chrome extension (optional, replaces Step 5)

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → `extension/`
2. In its options set server `http://localhost:8080` and **your own** API key —
   the same value as `MEET_API_KEY` in your `.env`
3. Open the meeting → click the extension → **Send this meeting to the bot**

---

## If something breaks

| Symptom | Fix |
|---|---|
| `credentials : MISSING` | Redo the login step (stop the container first) |
| `HTTP 409: busy` | A session is running: `tester.py leave <id>` |
| `HTTP 401` / extension says `unauthorized` | Your key does not match `.env`. Pass `--key`, or paste it into the extension. See [SECURITY.md](SECURITY.md). |
| `cannot reach ...:8080` | Container is down: `docker compose logs -f` |
| Stuck on `In the lobby` | Nobody admitted the bot |
| `profile is already open in another browser` | `docker stop meet-listener`, then rerun |
| No captions | Look at `.\data\debug\*.png` to see what the bot saw |
| Nothing arrives in the Step 2 terminal | `MEET_CALLBACK_KEY` in `.env` differs from `host_listener.py --key` |
| `.env` changes had no effect | `docker compose up -d` again — Compose reads it at start |
| `playwright: command not found` | The virtual environment is not active |

Full options: `python meet_listener.py --help`, `python tester.py --help`.

Tests, no meeting needed:

    python tests/test_captions.py
    python tests/test_server.py
    python tests/test_push.py
    python tests/test_assistant.py
    python tests/test_extension.py

---

## Working on this with other people

Never commit any of these — `.gitignore` already covers them, so the main way
they leak is `git add -f` or a stray copy outside the project:

| Path | What it is |
|---|---|
| `.env` | your API and callback keys |
| `creds/` | a signed-in Chrome profile — effectively your Google account |
| `data/`, `transcripts/` | recordings of real conversations |

Before your first push, `git status` should show none of them. If you add a new
setting, add it to `.env.example` with a comment (never a real value) so the
next person knows it exists.

---

Transcribing a meeting is subject to the consent rules of everyone in it.
Announce the bot before using it on a real call.
