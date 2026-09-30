# Compaction Algorithm

How Astra turns three noisy APIs into the small block of Markdown the meeting
bot is briefed with.

This is context engineering, not serialisation. The output is spent from a
model's context window before a single word of the meeting is transcribed, and
every token it costs is a token unavailable for the conversation it exists to
support. The constraint is not "make the JSON smaller" — it is **say the most
useful things, in the form a model reads best, in the fewest tokens.**

Measured on a real team, the pipeline takes what would be ~4,900 tokens of raw
API output down to **451**.

---

## The five stages

```
  GitHub · Jira · Slack          raw API responses
          │
          ▼
  1. FILTER      intersect everything with the roster        ~90% dropped
          │
          ▼
  2. TRIM        cap lists, cut text to its useful part      bounded size
          │
          ▼
  3. ANALYSE     derive conclusions once, deterministically  +34%, replaces reasoning
          │
          ▼
  4. PRUNE       drop nulls and empty collections            ~15% dropped
          │
          ▼
  5. RENDER      Markdown, not JSON                          ~52% dropped
          │
          ▼
     451 tokens → the bot
```

Stages 1–4 shape the structured payload. Stage 5 is what actually ships.

---

## 1. Filter — relevance before volume

The single biggest saving, and it happens before anything is held in memory.

Every fetched object is intersected with the **team roster**: PRs by people
outside the team, issues assigned elsewhere, commits from a bot account. A
repository with 400 open pull requests is noise; the six opened by people in
this standup are signal.

The roster is the cross-walk built in the Resource Pool — real name ↔ GitHub
login ↔ Jira `accountId` ↔ Slack member ID — which is why an employee with no
handles contributes nothing but their name.

*Also dropped here:* commits already claimed by an earlier branch (branches
share history, so a naive scan counts the same commit five times).

> **Rule: filtering must never be silent.** Anything dropped for *relevance* is
> named in `meta.truncated` — "4 commit(s) by souriesh — not in the resource
> pool". An unexplained absence is indistinguishable from a bug.

## 2. Trim — bounded, in one place

Hard caps, all in `LIMITS` in `src/lib/context/compaction.ts`:

| | Cap | Why |
|---|---|---|
| Open PRs | 20 | Beyond this it is a backlog, not an agenda |
| Commits | 30 | Across all branches, newest first |
| Jira issues | 50 | One sprint's worth |
| Branches scanned | 25 | One API call each |
| Commit window | 14 days | A sprint, roughly |
| Titles / summaries | 110 chars | |
| Commit messages | subject line only | The body is where the budget dies |

Raising the budget is a single edit, in a single file.

## 3. Analyse — spend tokens to save reasoning

The one stage that makes the payload *bigger* (+34%), and it pays for itself.

Asking a model to count issues, compare a burn rate against elapsed sprint time
and notice a PR has been open eleven days — mid-sentence, from a flat list — is
asking it to do arithmetic under time pressure, which is when models invent
numbers. So the arithmetic happens once, deterministically, in
`src/lib/context/analytics.ts`, and the payload carries conclusions.

A per-person rollup is also *cheaper* than the rows it summarises: one line per
person replaces every commit and issue they touched.

> **Rule: an absence is not a finding unless the scan completed.** Every
> conclusion drawn from silence is gated on `complete`. "Nobody heard from Kat
> this week" gets said out loud in a meeting; it must never be an artefact of a
> branch that returned 403.

## 4. Prune — drop what says nothing

Recursively removes `null`, `undefined` and empty collections. `"reviews": null`
costs tokens and teaches nothing; an absent key says the same for free.

**`meta` and `analysis`'s arrays are exempt.** There, an empty array *is* the
statement — `truncated: []` means "nothing was dropped" — and consumers read
`.length` directly. (This was a real bug: pruning ate `meta.truncated`, so the
cleanest possible run crashed the UI.)

A last-resort budget pass shrinks anything still over **96 KB**, shedding in
order of redundancy: commits first (the PR list already says what is in
flight), then PRs, then issues last, because the sprint board *is* the agenda.

## 5. Render — Markdown, not JSON

The final and second-largest saving. Measured on the real `Astra_dev` payload:

| Form | Bytes | ≈Tokens | |
|---|---|---|---|
| JSON, pretty | 5,731 | 1,433 | what a debugger reads |
| JSON, minified | 3,792 | 948 | |
| **Markdown** | **1,804** | **451** | **52% under minified JSON** |

Two reasons, and the second matters more:

**Structural.** An array of objects repeats every key on every row — thirty
commits pay for `"author":` thirty times. A table names each column once.
Braces, quotes and commas are tokens carrying no meaning to a reader.

**Cognitive.** Markdown tables and headings are overwhelmingly what these models
saw in training. A nested JSON object has to be parsed before it can be reasoned
about, and parsing costs attention the meeting needs.

Ordering is deliberate — **conclusion first, evidence after**: sprint verdict,
agenda, the room, risks, then the raw tables. A model that reads only the first
third still knows what the meeting is about.

> **Rule: omit empty sections entirely.** A heading with "none" underneath costs
> tokens to say nothing. Anything genuinely ambiguous — a source that *failed*
> rather than returned nothing — is stated once, in `## Notes`.

---

## Where each form is used

| | Structured JSON | Markdown |
|---|---|---|
| Computing the analysis | ✅ | |
| `pre_context_runs` audit row | ✅ | |
| Dashboard analysis view | ✅ | |
| **Sent to the bot** | | ✅ |
| Chrome extension `pre_context` | | ✅ |

The Markdown is **rendered on read, never stored**. The audit row keeps the
structured payload, so improving the renderer improves every past run too —
and a stored string could not be re-analysed.

`GET /api/teams/:id/precontext?format=json` returns the structured form for
anything that needs to read fields rather than reason about prose.

---

## Reading the result

Every payload reports its own compaction:

```jsonc
"meta": {
  "bytes": 3296, "token_estimate": 824,
  "truncated": [ "github: 4 commit(s) by souriesh — not in the resource pool" ],
  "sources": { "jira": { "skipped": "Jira is not configured for this team" } }
}
```

`meta.truncated` is the audit trail of stages 1, 2 and 4. If the bot seems to be
missing something, that array says who dropped it and why.
