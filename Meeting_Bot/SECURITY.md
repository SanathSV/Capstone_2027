# Why the keys exist

## The thing to understand first

This project runs **a browser that is logged into your Google account**, and it
takes orders over HTTP.

Anything that can reach the API can make *your* account join a meeting, sit in
it, and transcribe it. The bot appears in the participant list under **your
name**, because it is you. That is what all of the settings below are guarding.

---

## The three secrets

| Secret | Guards | If it is not set |
|---|---|---|
| `creds/` | Your live Google session | Anyone with the folder can act as you on Google |
| `MEET_API_KEY` | Who can send the bot somewhere | Anyone who reaches port 8080 can join any meeting as you |
| `MEET_CALLBACK_KEY` | Who can write to your transcripts | Anyone can inject fake lines into your transcript files |

### 1. `creds/` — the account itself

`creds/storage_state.json` holds Google session cookies in **plain JSON**. It is
not encrypted. Anyone holding that file can be signed in as you until the
session expires.

- It is in `.gitignore` and `.dockerignore` — **keep it that way.**
- Never commit it, paste it, or put it in an image.
- If it leaks: sign out everywhere in your Google account settings, which
  invalidates the cookies, then run `--login` again.

It is mounted into the container read-write because Chrome needs to update its
own profile. The container never logs in by itself — you do that once, on a
machine with a screen.

### 2. `MEET_API_KEY` — who can drive the bot

Every `/api/*` route except `/api/health` requires `X-API-Key`. Without a key
set, the server accepts **anyone**:

```bash
curl -X POST http://your-host:8080/api/join \
     -d '{"url":"https://meet.google.com/xxx-xxxx-xxx"}'
```

That is enough for a stranger to put your logged-in account into a meeting of
their choosing and read everything said in it.

`/api/health` is deliberately open so the extension can tell you *why* a call
failed before it fails — it reports whether a key is required, but no secrets.

**Set it:**

```powershell
$env:MEET_API_KEY = "a-long-random-string"
docker compose up -d
```

The extension and `tester.py` must send the same value. The extension stores it
in `chrome.storage.sync`; `tester.py` takes `--key` or `MEET_API_KEY`.

### 3. `MEET_CALLBACK_KEY` — who can write your transcripts

The container **pushes** transcripts to `host_listener.py` on your machine.
That listener accepts POSTs. Without a key, anything that can reach its port can
post fabricated caption lines, which get printed and written to
`transcripts/*.txt` as if they were real.

The value must match on both sides:

```powershell
python host_listener.py --port 9000 --key mysecret     # your machine
$env:MEET_CALLBACK_KEY = "mysecret"                    # the container
```

---

## Two settings that are not keys, but matter as much

### `MEET_REQUIRE_LOGIN` (default `1`)

Forces the bot to use the signed-in account and **refuse** to join as an
anonymous guest. Turning it off does not just change the name shown — a guest
join is a different, silent failure mode: the bot knocks, nobody admits it, and
the logs say "not admitted" rather than "your credentials are missing." Leave it
on unless you specifically want anonymous joins.

### `MEET_ALLOW_ANY_URL` (default `0`) — testing only

When on, `/api/join` will open **any URL**, not just `meet.google.com`. That
turns the API into "fetch any address in a browser that is logged into my Google
account" — a way to reach internal services and read the result. The test suite
sets it to point at a local mock page. **Never set it anywhere real.**

---

## Check your own setup

```powershell
docker inspect meet-listener --format '{{range .Config.Env}}{{println .}}{{end}}' | findstr MEET_
python tester.py health --key $env:MEET_API_KEY
```

`auth : required` means the API key is doing its job. `auth : open` means it is
not set.

Also check who can reach the port:

```powershell
docker port meet-listener
```

`0.0.0.0:8080` means **every machine on your network** can reach the API, not
just this computer. On a shared or campus network, either set a strong
`MEET_API_KEY` or bind it to localhost by changing the compose port mapping to
`127.0.0.1:8080:8080`.

---

## Rotating a key

1. Pick a new value: `python -c "import secrets; print(secrets.token_urlsafe(24))"`
2. `$env:MEET_API_KEY = "<new value>"` then `docker compose up -d`
3. Update the extension's **API key** field — it keeps the old one in storage
   and will fail with `unauthorized` until you do
4. Update `MEET_API_KEY` in any terminal that uses `tester.py`

---

## What these keys do *not* protect

- **Transcripts already on disk.** `data/transcripts/` and `transcripts/` are
  plain files containing everything that was said. They are gitignored, not
  encrypted.
- **Ollama.** It listens on `11434` with no authentication of its own. The
  container reaches it through `host.docker.internal`; anything else on your
  machine can too.
- **The meeting itself.** Nothing here can admit the bot to a call it was not
  let into, and nothing bypasses Meet's own permissions.

---

## Consent

Transcription is a people problem before it is a technical one. The bot shows up
in the participant list, but appearing in a list is not the same as telling
people that everything they say is being written to a file and sent to a
language model. Recording rules differ by country and by institution, and a
school or workplace account usually has its own policy on top.

Say what it does before you switch it on.
