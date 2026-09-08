# Astra — Chrome Extension

Summon a briefed bot into the Google Meet you are already looking at.

```
  Meet tab                                        Astra (npm run dev)
  ┌──────────────┐   1. read active tab URL       ┌────────────────────┐
  │ meet.google  │◀──────────────────────────────│                    │
  └──────────────┘                                │                    │
                     2. sign in (Supabase Auth)   │   Supabase         │
  ┌──────────────┐   3. teams where you are lead  │   ├ /auth/v1       │
  │  the popup   │◀─────────────────────────────▶│   └ /rest/v1/teams │
  │              │   4. prefetch on team select:  │                    │
  │  [Connect    │      GET /api/teams/{id}/precontext                 │
  │     Bot]     │      GET /api/bot-auth/session │                    │
  └──────┬───────┘                                │                    │
         │           5. POST /api/bot/summon      │                    │
         └───────────── {team_id, meet_link, ────▶│  prints 4 fields   │
                         pre_context,             │  returns success   │
                         bot_credentials}         └────────────────────┘
```

No build step. No bundler. Point **Load unpacked** at this folder and it runs.

---

## Install

1. **Configure.** Open [`config.js`](config.js) and set:

   | Value | Where from |
   |---|---|
   | `SUPABASE_URL` | Supabase → Settings → **Data API** → Project URL. The **bare origin** — *not* the "RESTful endpoint" ending in `/rest/v1`. |
   | `SUPABASE_ANON_KEY` | Supabase → Settings → **API Keys**. `sb_publishable_…` or the legacy `anon` JWT; either works. |
   | `API_BASE` | Where Astra runs. `http://localhost:3000` by default. |

2. **Start Astra** — `npm run dev` in the parent directory.

3. **Load it.** `chrome://extensions` → enable **Developer mode** → **Load
   unpacked** → select this `chrome-extension` folder.

4. **Sign in** in the popup with your Astra account.

> **Changing `API_BASE`?** Add that origin to `host_permissions` in
> [`manifest.json`](manifest.json) too. Chrome blocks any host not listed there,
> and the failure looks exactly like a CORS problem while never mentioning the
> manifest.

---

## Using it

Open a Google Meet, click the Astra icon (its badge turns green on a Meet tab),
pick a team. Both payloads are fetched **as soon as you choose the team**, not
when you press the button:

| Check | Green when |
|---|---|
| **Pre-context** | the payload is in hand — shows its size, and whether it came from a recent run or was just generated |
| **Bot credentials** | your bot account is authenticated on this machine |

You do **not** need to visit the dashboard first. If there is no recent payload
for the team, the endpoint generates one with the same engine the dashboard's
button uses — which takes a few seconds the first time, and the popup says so
rather than leaving a disabled button unexplained. A run under ten minutes old
is reused as-is.

**Connect Bot** stays disabled until both land. That is deliberate: by the time
someone opens this, the meeting has started. Pressing the button should be one
POST of data already in memory, not the beginning of a multi-second round trip
while a call goes on without its notetaker.

### When a check is red

| It says | Fix |
|---|---|
| This team has no members yet | Add people to the team in Astra — the roster is what every lookup filters by |
| Bot account is not authenticated | Astra → **Settings** → **Bot Account Setup** |
| Bot credentials are not served by this deployment | Set `ASTRA_ALLOW_LOCAL_BOT_AUTH=1` in `.env.local` and restart |
| Could not reach Astra at … | `npm run dev` is not running, or `API_BASE` is missing from `host_permissions` |
| You do not lead any teams | The bot is summoned on behalf of a team you lead — create one |

---

## How it is put together

| File | Does |
|---|---|
| `manifest.json` | MV3. Permissions: `storage`, `tabs`, `alarms`. |
| `config.js` | The three values above. |
| `popup.html/.css/.js` | The three panes: unconfigured, sign in, ready. |
| `background.js` | Refreshes the session on an alarm; paints the tab badge. |
| `lib/supabase.js` | Auth and PostgREST over `fetch`. |
| `lib/session.js` | The session in `chrome.storage.local`. |
| `lib/api.js` | Calls into Astra, always as the signed-in leader. |

**Why no `@supabase/supabase-js`.** Manifest V3 forbids remotely-hosted code, so
the library would have to be bundled — a build step and a `dist/` in an
extension whose whole appeal is that "Load unpacked" just works. What it does
here is two REST endpoints: `POST /auth/v1/token` and `GET /rest/v1/teams`.

**Session storage.** `access_token`, `refresh_token`, the expiry and the user go
in `chrome.storage.local` — scoped to the extension and unreadable by web pages,
unlike `localStorage` on a page. A popup is destroyed every time it closes, so
without this you would sign in on every click. Access tokens last about an hour;
`background.js` refreshes on a 30-minute alarm so a click never lands on a dead
token, and a spent refresh token clears the session rather than failing again.

**The anon key ships in the extension, and that is fine.** It grants nothing on
its own — every query it makes is still filtered by the RLS policies, so it can
only ever read what the signed-in user could read anyway.

---

## Security notes

- **`bot_credentials` is a live Google session.** It is fetched into the
  popup's memory, posted once, and gone when the popup closes. It is
  deliberately **never** written to `chrome.storage`, where it would outlive the
  click that needed it with nobody watching it.
- **`/api/bot-auth/session` only ever returns your own credentials**, and only
  when `ASTRA_ALLOW_LOCAL_BOT_AUTH=1`. There is no user id in the request to
  swap for someone else's.
- **The server logs the credential's shape, never its contents** — counts,
  state, and the bot's own email address. A terminal log is the easiest place to
  leak a secret from: scrollback, CI output, a screenshot posted while debugging.
- **Round-tripping the credential through a browser is a Phase-1 convenience,
  not a design.** In Phase 2 the bot container fetches it straight from Supabase
  Storage at `leaders/{user_id}/auth.json` with a short-lived signed URL, and
  `/api/bot-auth/session` goes away.
- **Leadership is checked server-side.** The extension sends a `team_id`, and a
  `team_id` is trivially forged, so `/api/bot/summon` re-checks it against the
  database.
