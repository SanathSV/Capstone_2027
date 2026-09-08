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

export function summonBot(token, payload) {
  return call("/api/bot/summon", { token, method: "POST", body: payload });
}
