# What each file does

Steps to run: [RUNNING.md](RUNNING.md). Design and API: [ARCHITECTURE.md](ARCHITECTURE.md).
Why the keys exist: [SECURITY.md](SECURITY.md).

| File | Runs on | Purpose |
|---|---|---|
| `meet_listener.py` | host or container | The bot. Joins, mutes, turns on captions, scrapes them. |
| `server.py` | container | HTTP API. Takes a URL, runs a bot, pushes the transcript out. |
| `host_listener.py` | **your machine** | Receives pushed transcripts, prints and saves them. |
| `tester.py` | anywhere | Command-line client for the API. |
| `assistant.py` | host or container | Wake word -> greet in chat -> listen -> ask Ollama -> answer in chat. |
| `extension/` | Chrome | Sends the current Meet tab to the container. |
| `Dockerfile` | build | Builds the container image. |
| `docker-entrypoint.sh` | container | Starts the virtual display, then the server. |
| `docker-compose.yml` | host | Wires up ports, volumes and settings. |
| `requirements.txt` | build | Python dependencies. |
| `tests/` | host | Proves it works without a real meeting. |
| `creds/` | host + container | **Your Google session. Treat as a password.** |
| `data/` | container | Transcripts and debug screenshots. |

---

## The four programs

### `meet_listener.py` — the bot (1400 lines)

Everything that touches Google Meet. Works standalone or as a library the
server imports.

```powershell
python meet_listener.py --login --profile ./creds     # sign in, once
python meet_listener.py --url https://meet.google.com/abc-defg-hij
```

Inside it:

- **`run_meeting()`** — the whole flow: open, mute, join, wait out the lobby,
  turn on captions, listen, leave.
- **`CAPTION_OBSERVER_JS`** — JavaScript injected into the page. A
  `MutationObserver` watches the caption area and pushes each change to Python.
  **Edit the selector lists at the top of it when Google renames things** — that
  is the most likely thing to break.
- **`CaptionSink`** — turns the stream of growing caption snapshots into printed
  lines that are not duplicated.
- **`enable_captions()`** — four ways to switch captions on, verified after each.
- **`profile_has_google_session()`** — is this profile really signed in.
- **`export_storage_state()`** — writes `creds/storage_state.json`, the portable
  form of your login (a Chrome profile alone does not work across operating
  systems).

### `server.py` — the API (640 lines)

Runs inside the container, owns the browser, and never logs in by itself.

- **`SessionManager`** — one bot per session, tracks their state.
- **`_pusher()`** — batches finished lines and POSTs them to your host listener,
  with retries. A dead listener never stalls transcription.
- **Endpoints** — `/api/health`, `/api/join`, `/api/sessions`,
  `.../transcript?since=N`, `.../leave`.
- Refuses to join at all if `creds/` has no Google session, rather than quietly
  joining as an anonymous guest.

### `assistant.py` — the in-meeting assistant (200 lines)

Say **"Astra"** or **"yo bot"** out loud and the bot replies in the meeting chat.

- **`build_wake_pattern()`** — matches stretched speech: `yooo bot`, `astraaa`,
  but not `orchestra` or `robot`.
- **`Assistant`** — idle → greet → listen → think → idle. A question asked in the
  same breath ("Astra, what is a container?") skips the waiting step.
- **`ask_ollama()`** — posts to your local Ollama with the prompt
  *"Answer this in simple words."*

Turn it on with `--assistant`, or `MEET_ASSISTANT=1` in the container. Ollama
runs on your host, so the container reaches it at `host.docker.internal:11434`.

### `host_listener.py` — the receiver (200 lines)

Runs on **your** machine, not in Docker. The container POSTs to it as the bot
hears things.

```powershell
python host_listener.py --port 9000 --key mysecret
```

Prints the transcript live and writes `transcripts/<session>.txt` and `.jsonl`.
`GET /` and `GET /sessions` show what has arrived.

### `tester.py` — the client (270 lines)

Standard library only, so it runs anywhere.

```powershell
python tester.py health
python tester.py join "<meet link>" --watch
python tester.py list | transcript <id> | leave <id> | rm <id>
```

---

## The extension

| File | Purpose |
|---|---|
| `manifest.json` | Chrome MV3 declaration: permissions, popup, options page. |
| `popup.js` | Reads the active tab's Meet URL, POSTs it, then polls the transcript. |
| `popup.html` | The popup layout. |
| `options.js` / `options.html` | Stores the server URL, API key and bot name. |

Load with `chrome://extensions` → Developer mode → Load unpacked → `extension/`.

---

## The container

| File | Purpose |
|---|---|
| `Dockerfile` | Playwright base image, installs **real Google Chrome**, copies the code. |
| `docker-entrypoint.sh` | Starts Xvfb (a virtual screen), waits for it, then runs the server and supervises it. Meet blocks headless browsers, so the browser runs headful against a fake display. |
| `docker-compose.yml` | Ports, the `creds/` and `data/` mounts, and every `MEET_*` setting. **This is the file to edit to change behaviour.** |
| `.dockerignore` | Keeps `creds/` and test data out of the image. |

---

## Tests

No meeting required — they drive the real code against a fake Meet page in a
real browser.

| File | Covers |
|---|---|
| `tests/fake_meet.html` | A mock Meet: green room, join button, captions that grow like the real ones. |
| `tests/test_captions.py` | The CC click, caption scraping, the whole `run_meeting()` flow, and leaving an empty meeting. |
| `tests/test_server.py` | Starts `server.py` for real and drives it like the extension does, including auth and the busy case. |
| `tests/test_push.py` | Starts `server.py` **and** `host_listener.py` and checks the transcript arrives with nobody polling. |
| `tests/test_assistant.py` | Wake-word matching, the greet/listen/answer state machine, and a real call to Ollama. |
| `tests/test_extension.py` | Runs popup.js in a real browser against a stub API: join, polling, the Astra panel, leave. |

---

## Data and credentials

| Path | Contents |
|---|---|
| `creds/` | Chrome profile plus `storage_state.json`. **A live Google session — never commit or share it.** The container reads `storage_state.json`. |
| `data/transcripts/` | One `.jsonl` per session, written by the container. |
| `data/debug/` | Screenshots and page text saved when something fails. Look here first when the bot does nothing. |
| `transcripts/` | What `host_listener.py` saves on your machine. |

`.gitignore` already excludes `creds/`, `data/` and `transcripts/`.

---

## Not part of this project

`sem6/` is your own separate folder. Nothing here reads or writes it.
