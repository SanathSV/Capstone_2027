# Connecting GitHub, Jira and Slack to Astra

Everything Astra harvests is filtered through one idea: **the roster**. A
repository with 400 open pull requests is noise; the six opened by people in
this standup are signal. So the setup has two halves, and the first one is the
one people skip:

1. **Per person, once** — record their GitHub username, Jira account ID and
   Slack user ID in the Resource Pool. Without these, a person appears on the
   roster and in nothing else.
2. **Per team, once** — paste the API credentials on the team page.

Every credential is optional. A team with only GitHub configured produces a
smaller payload, not a broken one.

> **Where the tokens go.** They are encrypted with AES-256-GCM before they touch
> the database and are never sent back to the browser — the settings form shows
> "stored", not a masked value. Only the team leader can read or write them, at
> the database level, not just in the UI.

---

## Contents

- [Part 1 — the per-person handles](#part-1--the-per-person-handles)
- [Part 2 — GitHub](#part-2--github)
- [Part 3 — Jira](#part-3--jira)
- [Part 4 — Slack](#part-4--slack)
- [Verifying the whole chain](#verifying-the-whole-chain)
- [Troubleshooting](#troubleshooting)
- [What Astra actually calls](#what-astra-actually-calls)

---

## Part 1 — the per-person handles

**Resource Pool → Add an employee.** Three fields, three different systems, and
all three are easy to fill in wrongly because each one has a plausible-looking
decoy.

### GitHub username

The handle in `github.com/<handle>` — `gracehopper`, not `Grace Hopper` and not
the profile URL.

Fastest way to check a whole team at once:

```bash
gh api users/gracehopper --jq '.login + "  " + .name'
```

**The decoy:** the *display name* on someone's profile. Commits are attributed
by `login`; a display name matches nothing.

### Jira account ID

Not an email, not a username. Atlassian Cloud identifies people by an opaque
`accountId` such as `5b10a2844c20165700ede21g`, and has done since it stopped
exposing usernames for GDPR reasons.

Three ways to get it:

```bash
# 1. Your own, as a sanity check that your token works at all:
curl -s -u "you@company.com:$JIRA_TOKEN" \
  "https://your-site.atlassian.net/rest/api/3/myself" | jq '.accountId, .displayName'

# 2. Everyone matching a name or email — the one to use for filling the pool:
curl -s -u "you@company.com:$JIRA_TOKEN" \
  "https://your-site.atlassian.net/rest/api/3/user/search?query=grace" \
  | jq -r '.[] | .accountId + "  " + .displayName + "  " + (.emailAddress // "hidden")'
```

3. Or open their Jira profile in a browser — the ID is the last segment of the
   URL: `.../jira/people/5b10a2844c20165700ede21g`.

**The decoy:** the email address. Jira's JQL `assignee` clause takes account IDs;
an email silently matches nothing and the person quietly vanishes from the
payload.

### Slack user ID

Starts with `U` (or `W` for some enterprise accounts): `U01ABCDEF`.

In Slack: click the person → **More (⋯)** → **Copy member ID**.

Or in bulk, once you have a bot token:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/users.list" \
  | jq -r '.members[] | select(.deleted==false) | .id + "  " + (.profile.email // "-") + "  " + .real_name'
```

**The decoy:** `@grace`, the display name. It is not the member ID.

### Checking your work

Open the Resource Pool. Each person shows three chips — `gh:`, `jira:`,
`slack:`. A dash means the handle is missing. On the team page the same
information is three dots per row: filled means recorded, hollow means not.

Anyone with no handles at all is flagged **no handles** when you add them to a
team, because they will appear on the roster and contribute nothing else.

---

## Part 2 — GitHub

### What Astra gets from it

- Repository name, description, default branch, primary language
- **Open pull requests** authored by roster members — age, draft state, labels,
  who review is waiting on
- **Commits from the last 14 days** by roster members, and a per-person count
- Which team members have committed *nothing* in that window

### Creating the token

Use a **fine-grained personal access token** — it is scoped to specific
repositories, which a classic token is not.

1. GitHub → your avatar → **Settings** → **Developer settings**
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
3. Fill in:

   | Field | Value |
   |---|---|
   | Token name | `astra-precontext-<team>` |
   | Resource owner | the org that owns the repo (not your personal account, if the repo is in an org) |
   | Expiration | 90 days is a reasonable default — Astra reports a 401 clearly when it lapses |
   | Repository access | **Only select repositories** → the team's repo |

4. **Repository permissions** — read-only, three of them:

   | Permission | Access | Why |
   |---|---|---|
   | **Metadata** | Read-only | Mandatory; GitHub selects it for you |
   | **Contents** | Read-only | Commit history |
   | **Pull requests** | Read-only | Open PRs, reviewers, labels |

   Nothing else. Astra never writes to GitHub.

5. **Generate token** and copy it — `github_pat_…`, shown exactly once.

> **Org with SSO?** After creating the token, click **Configure SSO** next to it
> and authorise your organisation. Without that step every call returns 403 with
> a message about SAML enforcement.

### Entering it

Team page → **Integrations** → **GitHub**:

| Field | Example |
|---|---|
| Repository URL | `https://github.com/acme/payments` |
| API token | `github_pat_…` |

The URL must be `https://github.com/owner/repo` — a `.git` suffix or a trailing
slash is stripped for you, but a link to a branch or a file is rejected.

### Verify before you rely on it

```bash
export GH_TOKEN=github_pat_...
curl -s -H "Authorization: Bearer $GH_TOKEN" \
     -H "X-GitHub-Api-Version: 2022-11-28" \
     https://api.github.com/repos/acme/payments | jq '.full_name, .default_branch'

# The same list Astra reads:
curl -s -H "Authorization: Bearer $GH_TOKEN" \
  "https://api.github.com/repos/acme/payments/pulls?state=open&per_page=5" \
  | jq -r '.[] | "#\(.number) \(.user.login)  \(.title)"'
```

If the second command lists PRs whose `user.login` values are *not* in your
resource pool, that is exactly the mismatch to fix — those PRs will be filtered
out of the payload.

### Rate limits

A fine-grained token gets 5,000 requests/hour. Astra spends **three** per run.
You are not going to hit this.

---

## Part 3 — Jira

### What Astra gets from it

- The project's board, and its **active sprint**: name, state, start/end dates,
  days remaining
- **The sprint goal** — one sentence, and usually the most valuable line in the
  whole payload
- **Issues in that sprint assigned to roster members**: key, summary, status,
  type, priority, story points
- Counts by status category, and which team members have nothing assigned

If the project has no board, or no sprint is running, Astra falls back to open
(`statusCategory != Done`) issues assigned to the roster — so a Kanban team still
gets useful context.

### Creating the token

Jira Cloud uses **Basic auth with an API token**: the username is the *email
address of the account the token belongs to*, and the password is the token.

1. Go to **<https://id.atlassian.com/manage-profile/security/api-tokens>**
2. **Create API token**, label it `astra-precontext`
3. Copy it — `ATATT…`, shown once

The token inherits **that account's permissions**. So:

> **Use a dedicated bot account** with *Browse Projects* on the project you are
> connecting, rather than a human's token. A personal token stops working the
> day that person changes roles, and it can see everything they can see.

The account needs, at minimum:

| Permission | For |
|---|---|
| **Browse Projects** on the project | issue search |
| Board visibility (usually implied by Browse Projects) | sprint and goal lookup |

### Finding the project key

The prefix on every issue key: `PAY-812` → the key is `PAY`. It is also in the
URL of the project board. Short, upper-case.

### Entering it

Team page → **Integrations** → **Jira**:

| Field | Example | Notes |
|---|---|---|
| Base URL | `https://acme.atlassian.net` | No path, no trailing slash |
| Project key | `PAY` | Upper-cased for you |
| Account email | `astra-bot@acme.com` | **The account the token belongs to** |
| API token | `ATATT…` | |

The single most common mistake here is putting a *different person's* email next
to the token. Basic auth needs the matching pair, and a mismatch returns a 401
that looks exactly like a bad token.

### Verify before you rely on it

```bash
export JIRA_SITE=https://acme.atlassian.net
export JIRA_AUTH="astra-bot@acme.com:ATATT..."

# 1. Does the credential pair work at all?
curl -s -u "$JIRA_AUTH" "$JIRA_SITE/rest/api/3/myself" | jq '.accountId, .displayName'

# 2. Is there a board for the project?
curl -s -u "$JIRA_AUTH" \
  "$JIRA_SITE/rest/agile/1.0/board?projectKeyOrId=PAY" | jq '.values[] | {id, name}'

# 3. Is a sprint running, and does it have a goal?
curl -s -u "$JIRA_AUTH" \
  "$JIRA_SITE/rest/agile/1.0/board/42/sprint?state=active" \
  | jq '.values[] | {name, goal, endDate}'

# 4. The issue search Astra runs (note: /search/jql, the enhanced endpoint):
curl -s -u "$JIRA_AUTH" -G "$JIRA_SITE/rest/api/3/search/jql" \
  --data-urlencode 'jql=project = "PAY" AND sprint = 99 ORDER BY updated DESC' \
  --data-urlencode 'fields=summary,status,assignee' \
  | jq -r '.issues[] | .key + "  " + .fields.status.name + "  " + (.fields.assignee.displayName // "unassigned")'
```

> **On `/rest/api/3/search/jql`.** The older `/rest/api/3/search` endpoint was
> deprecated in October 2024 and **removed in August 2025** — it now answers
> `410 Gone`. Astra uses the enhanced-search replacement, which paginates with an
> opaque `nextPageToken` instead of `startAt` and no longer returns a `total`.
> If you find an older integration guide (or an LLM) still calling
> `/rest/api/3/search`, that is why it fails.

### Story points

Story points live in a per-site custom field. Astra reads
`customfield_10016`, `customfield_10024` and `customfield_10004` — the common
ids — and simply omits the field when none of them match. To find yours:

```bash
curl -s -u "$JIRA_AUTH" "$JIRA_SITE/rest/api/3/field" \
  | jq -r '.[] | select(.name | test("point"; "i")) | .id + "  " + .name'
```

Add it to `POINT_FIELDS` in `src/lib/context/jira.ts` if it is not in the list.

---

## Part 4 — Slack

Slack is the smallest integration and deliberately so. Astra does **not** read
message history: it is enormous, mostly noise, and the bot listens to the
meeting rather than the channel.

What Slack is genuinely good for here is **verifying the cross-walk** —
confirming that the member IDs in the resource pool are real people actually in
the standup's channel, so a typo surfaces before the meeting rather than as a
silently missing person afterwards.

### Creating the app and token

1. **<https://api.slack.com/apps>** → **Create New App** → **From scratch**
2. Name it `Astra`, pick your workspace
3. **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:

   | Scope | Why |
   |---|---|
   | `channels:read` | public channel info and membership |
   | `groups:read` | the same for private channels |
   | `users:read` | resolving member IDs to people |

4. **Install to Workspace**, authorise
5. Copy the **Bot User OAuth Token** — `xoxb-…`

6. **Invite the app to the channel.** In Slack: `/invite @Astra`. Without this
   step every call returns `not_in_channel`, which is not a permissions problem
   and no amount of extra scopes will fix it.

### Finding the channel ID

Open the channel → click its name → scroll to the bottom of the details panel →
**Channel ID**, `C01ABCDEF`. (The ID is also the last path segment of a channel
link.)

### Entering it

Team page → **Integrations** → **Slack**:

| Field | Example |
|---|---|
| Channel ID | `C01ABCDEF` |
| Bot token | `xoxb-…` |

### Verify

```bash
export SLACK_BOT_TOKEN=xoxb-...
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.info?channel=C01ABCDEF" | jq '.ok, .error, .channel.name'
```

`"ok": true` and the channel name means you are done. Slack answers HTTP 200 even
for failures, so always read `.ok`.

---

## Verifying the whole chain

1. Resource Pool → every person on the team has the handles they should have.
2. Team page → all three integration dots are **green**.
3. Press **Generate Pre-Context**.
4. Read the three source cards:

   | Card | Means |
   |---|---|
   | **ok** — `31 object(s) in 640 ms` | working |
   | **skipped** — `GitHub is not configured for this team` | no credentials saved; not an error |
   | **failed** — with the reason | see below |

5. Read the **digest**. If it says *"No commits in the window from: katjohnson"*
   about someone who has definitely been committing, their GitHub username in the
   resource pool does not match their actual login.

The payload is also printed to your `npm run dev` terminal, in full.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| GitHub **401** | Token wrong, expired, or revoked | Regenerate; re-paste |
| GitHub **403** mentioning SAML/SSO | Token not authorised for the org | Token settings → **Configure SSO** → authorise |
| GitHub **403** otherwise | Missing repository permission | Add Contents + Pull requests, read-only |
| GitHub **404** on a repo you can see | Fine-grained token not scoped to that repo, or the owner is wrong | Re-issue with the right resource owner |
| Jira **401** | Email and token belong to different accounts | Use the email of the token's own account |
| Jira **403** | Account lacks *Browse Projects* | Grant it on the project |
| Jira **410 Gone** | Something is still calling `/rest/api/3/search` | Astra uses `/search/jql`; check any custom code |
| Jira sprint section missing | No board, or no *active* sprint | Expected — Astra falls back to open issues |
| Jira issues empty, sprint present | Account IDs in the pool are wrong (emails?) | Re-check with `/rest/api/3/user/search` |
| Slack `not_in_channel` | App not invited | `/invite @Astra` in the channel |
| Slack `missing_scope` | Scope missing | Add it, then **reinstall** the app |
| Slack `channel_not_found` | Wrong ID, or a private channel without `groups:read` | Re-copy the ID; add the scope |
| **All three fail** with a decryption error | `ASTRA_ENCRYPTION_KEY` changed | Re-enter every token so they re-encrypt |
| Someone is in the roster but nowhere else | No handles recorded | Resource Pool → add them |
| `partial` status | Some sources failed, some worked | Read the cards; the payload is still usable |

### A note on rotation

Rotating a token is: create the new one, paste it into the team page, press
**Save**, delete the old one. Nothing is cached — the next run picks it up.

Clearing one is explicit: the **clear** link next to "stored". Saving the form
with an empty password box leaves the existing token alone, on purpose, so that
changing a channel ID cannot silently wipe your bot token.

---

## What Astra actually calls

Every request is read-only. Three sources, in parallel, each failing
independently. Source:
[`src/lib/context/`](src/lib/context/).

### GitHub — 3 requests

```http
GET https://api.github.com/repos/{owner}/{repo}
GET https://api.github.com/repos/{owner}/{repo}/pulls?state=open&sort=updated&direction=desc&per_page=100
GET https://api.github.com/repos/{owner}/{repo}/commits?since={14 days ago}&per_page=100
```

Headers: `Authorization: Bearer <token>`, `X-GitHub-Api-Version: 2022-11-28`.

### Jira — 3 requests

```http
GET {base}/rest/agile/1.0/board?projectKeyOrId={KEY}&maxResults=1
GET {base}/rest/agile/1.0/board/{boardId}/sprint?state=active&maxResults=1
GET {base}/rest/api/3/search/jql?jql=...&maxResults=50&fields=...
```

Header: `Authorization: Basic base64(email:token)`.

The JQL Astra builds:

```sql
project = "PAY" AND sprint = 99
  AND assignee in ("5b10a284…", "5b10a285…")
  ORDER BY updated DESC
```

…or, with no active sprint, `statusCategory != Done` in place of the sprint
clause.

### Slack — 2 requests

```http
GET https://slack.com/api/conversations.info?channel={id}
GET https://slack.com/api/conversations.members?channel={id}&limit=200
```

Header: `Authorization: Bearer xoxb-…`.

### Failure handling

Every call goes through `src/lib/context/http.ts`, which gives all three sources
the same behaviour:

- **12-second timeout** per request, so a hung connection cannot leave the button
  spinning.
- **Three attempts** with backoff for 429/408/5xx. A 401 or 404 is *not* retried
  — retrying a bad token just burns the rate limit and delays the error you need
  to see.
- **Errors are sentences**, not statuses: "GitHub refused the request (403). The
  token is missing a scope, or you are rate limited."
