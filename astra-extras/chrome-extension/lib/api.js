import { CONFIG } from "../config.js";

/**
 * Calls into the Astra backend, always as the signed-in leader.
 *
 * Every request carries `Authorization: Bearer <supabase access token>`; the
 * server resolves the user from it and applies the same RLS policies the
 * dashboard gets. The extension is not a privileged client — it is the leader,
 * using a different window.
 */

async function call(path, { token, method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`${CONFIG.API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // A network-level failure here is nearly always one of two things, and the
    // browser's own message ("Failed to fetch") names neither.
    throw new Error(
      `Could not reach Astra at ${CONFIG.API_BASE}. Is \`npm run dev\` running, ` +
        `and is that origin listed in host_permissions in manifest.json? (${error.message})`,
    );
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
  }
  return payload;
}

/**
 * The team's pre-context payload.
 *
 * The endpoint hands back a recent run when it has one and otherwise generates
 * a fresh payload with the same engine the dashboard's button uses — so a team
 * nobody has pressed that button for still works, which is the whole point of
 * being able to summon a bot from a meeting.
 *
 * The value comes back as **Markdown**, not JSON, because it is bound for a
 * model's context window rather than a parser — roughly half the tokens for the
 * same facts. `?format=json` returns the structured payload for anything that
 * needs to read fields. See COMPACTION_ALGO.md.
 */
export function fetchPreContext(token, teamId) {
  return call(`/api/teams/${teamId}/precontext`, { token });
}

/**
 * The leader's own Google bot session.
 *
 * Held only for as long as it takes to post it to /api/bot/summon, and never
 * written to chrome.storage — a live Google session on disk in an extension
 * profile is a credential nobody is watching.
 */
export function fetchBotCredentials(token) {
  return call("/api/bot-auth/session", { token });
}

/** Status only: safe to show, carries no cookies. */
export function fetchBotStatus(token) {
  return call("/api/bot-auth", { token });
}

/**
 * The Phase-1 dashboard endpoint. Kept because it is a useful capture point —
 * it authenticates the caller, checks leadership against the database, and
 * writes the request to `_sent_data_extension/` — but it is no longer what the
 * button calls. `dispatchBot` is.
 */
export function summonBot(token, payload) {
  return call("/api/bot/summon", { token, method: "POST", body: payload });
}

/**
 * Send the bot into the meeting.
 *
 * This goes to BOT-CONTAINER, not to the dashboard: the container is the thing
 * that owns a browser and can actually join a call. The payload is unchanged —
 * the same four fields, `pre_context` still Markdown — because the container
 * accepts exactly what the dashboard endpoint accepted, and anything extra it
 * does not recognise it ignores rather than rejects.
 *
 * The container answers **202, not 200**. A meeting lasts as long as a meeting
 * lasts, so it validates, opens the meeting row, and returns a `session_id`
 * while the join happens behind it. A 200 here would mean the request had been
 * held open for the length of the standup.
 */
export function dispatchBot(payload, { token } = {}) {
  return botCall(CONFIG.BOT_DISPATCH_PATH, { method: "POST", body: payload, token });
}

/**
 * Is there already a bot in this meeting?
 *
 * Asked of the container, not of `chrome.storage`, because the container is the
 * only thing that actually knows. A session id remembered in the browser goes
 * stale the moment the bot leaves, is wrong after a container restart, and is
 * missing entirely if the bot was summoned from another profile or machine.
 *
 * This is what stops the popup offering "Connect Bot" for a room that already
 * has one — the popup's own memory is destroyed every time it closes, so it has
 * to re-derive that on every open.
 */
export async function fetchLiveSession(meetLink, { token } = {}) {
  const query = `?meet_link=${encodeURIComponent(meetLink)}&active=1`;
  const body = await botCall(`/api/sessions${query}`, { token });
  // Newest first: if a previous bot failed and was re-summoned, the live one is
  // the one that matters.
  const sessions = body?.sessions ?? [];
  return sessions.length ? sessions[sessions.length - 1] : null;
}

/**
 * The container itself: is it up, can it reach Supabase, how many bots is it
 * running?
 *
 * Worth its own call rather than being inferred from a failed session lookup.
 * "No bot in this room" and "the bot service is down" look identical from the
 * summon side and mean completely different things — one is normal, the other
 * means Connect Bot is about to fail.
 */
export function fetchContainerHealth() {
  return botCall("/health");
}

export async function fetchSession(sessionId, { token } = {}) {
  const body = await botCall(`/api/sessions/${sessionId}`, { token });
  return body?.session ?? null;
}

/** Make the bot leave: flushes captions, drains the queue, writes the summary. */
export async function stopBot(sessionId, { token } = {}) {
  const body = await botCall(`/api/sessions/${sessionId}/stop`, { method: "POST", token });
  return body?.session ?? null;
}

/**
 * Calls into BOT-CONTAINER.
 *
 * Separate from `call()` above because it is a different service on a different
 * port with different auth: the dashboard authenticates you as a Supabase user,
 * the container checks a shared secret and nothing else.
 */
async function botCall(path, { method = "GET", body, token } = {}) {
  const url = `${CONFIG.BOT_API_BASE}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        // The container's own secret, in its own header so it does not collide
        // with the Supabase bearer token some deployments still forward.
        ...(CONFIG.BOT_API_TOKEN ? { "x-astra-token": CONFIG.BOT_API_TOKEN } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new Error(
      `Could not reach the bot container at ${CONFIG.BOT_API_BASE}. Is it running ` +
        `(\`docker compose up\` in BOT-CONTAINER/), and is that origin listed in ` +
        `host_permissions in manifest.json? (${error.message})`,
    );
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
  }
  return payload;
}
