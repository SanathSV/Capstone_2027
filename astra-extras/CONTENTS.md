# Astra supporting tools

These files are outside the website's Cloudflare build root.

| Path | Purpose |
| --- | --- |
| `bot-auth/` | Local Python/Playwright Google sign-in tool and ignored local credentials |
| `chrome-extension/` | Standalone Chrome extension; load this folder unpacked in Chrome |
| `supabase/` | Database setup and migration SQL; moved unchanged, never run automatically |
| `_sent_data_extension/` | Existing local request captures; ignored by Git |
| `README.md` | Detailed original project guide, with path notes |
| `INTEGRATIONS.md` | Integration setup reference |
| `COMPACTION_ALGO.md` | Context compaction design |

Run the website from `../astra-platform`. Its development-only bot tools resolve
their data here. Existing credentials and request captures were moved, not deleted.
Re-load the extension from this new location if Chrome still points to its old folder.

To enable local sign-in, install `bot-auth/requirements.txt`, install Playwright's
Chromium, then set `ASTRA_ALLOW_LOCAL_BOT_AUTH=1` in the website's `.env.local` and
run `npm run dev` from `astra-platform`. Production builds disable the local tools.
