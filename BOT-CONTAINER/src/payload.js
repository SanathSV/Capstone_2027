/**
 * Reading the summon payload.
 *
 * The contract is deliberately loose in one direction and strict in the other:
 * **extra fields are ignored, missing core fields are refused.** The dashboard
 * and the extension will grow fields over time (a sprint id, a language, an
 * analytics blob) and a container that 400s on an unknown key would break every
 * time the sender is deployed before the bot is. So unknown keys are dropped
 * without comment, and only the four the bot actually cannot run without are
 * enforced.
 *
 * Aliases are accepted for the same reason. `meet_link`, `meetLink` and `url`
 * all mean the same thing to a human, and rejecting two of the three teaches
 * the caller nothing.
 */

const MEET_URL =
  /^https:\/\/meet\.google\.com\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[a-z0-9-]+)(?:[?#].*)?$/i;

function pick(source, names) {
  for (const name of names) {
    const value = source?.[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function text(value) {
  return typeof value === "string" ? value.trim() : undefined;
}

export class PayloadError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "PayloadError";
    this.status = 400;
    this.field = field;
  }
}

/**
 * Normalises the credentials into one of two shapes the browser layer knows how
 * to use, keeping the distinction explicit rather than guessing later:
 *
 *   { mode: "storage_state", storageState, email }   cookies exported by Astra
 *   { mode: "password", email, password }            an actual Google login
 *   { mode: "guest" }                                nothing usable
 *
 * The spec asks for email+password. Astra's own dashboard sends a Playwright
 * storage state instead, and that is the form that actually works: Google
 * blocks scripted password sign-in from an automated browser ("this browser or
 * app may not be secure") often enough that a bot depending on it is a bot that
 * fails during the demo. Both are supported; storage state wins when both are
 * present, and the password path is attempted rather than promised.
 */
export function normaliseCredentials(raw) {
  if (!raw || typeof raw !== "object") return { mode: "guest" };

  const email = text(pick(raw, ["email", "google_email", "username", "user"])) ?? null;
  const password = text(pick(raw, ["password", "pass", "secret"])) ?? null;

  // A storage state is `{cookies: [...], origins: [...]}`. Astra nests neither,
  // but a caller wrapping it in `storage_state` is an obvious thing to do.
  const nested = raw.storage_state ?? raw.storageState ?? raw.state;
  const candidate = Array.isArray(raw.cookies) ? raw : nested;

  if (candidate && Array.isArray(candidate.cookies) && candidate.cookies.length) {
    return {
      mode: "storage_state",
      email: email ?? text(candidate.google_email) ?? null,
      storageState: {
        cookies: candidate.cookies,
        origins: Array.isArray(candidate.origins) ? candidate.origins : [],
      },
      expiresAt: text(pick(raw, ["expires_at", "expiresAt"])) ?? null,
    };
  }

  if (email && password) return { mode: "password", email, password };

  return { mode: "guest", email };
}

/**
 * Pre-context arrives as Markdown (Astra renders it that way — roughly half the
 * tokens of the equivalent JSON, see COMPACTION_ALGO.md in astra-platform), but
 * an object is accepted and stringified so a caller that has not migrated still
 * gets a briefed bot rather than a silent one.
 */
export function normalisePreContext(raw) {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    // `{markdown: "..."}` and `{payload: {...}}` are both plausible wrappers.
    if (typeof raw.markdown === "string") return raw.markdown.trim();
    if (typeof raw.text === "string") return raw.text.trim();
    try {
      return JSON.stringify(raw.payload ?? raw, null, 2);
    } catch {
      return "";
    }
  }
  return "";
}

/** Extract the four core parameters; everything else in `body` is ignored. */
export function parseSummon(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PayloadError("Expected a JSON object body.", "body");
  }

  const teamId = text(pick(body, ["team_id", "teamId", "workspace_id", "team"]));
  const meetLink = text(pick(body, ["meet_link", "meetLink", "meeting_url", "url"]));

  if (!teamId) throw new PayloadError("team_id is required.", "team_id");
  if (!meetLink) throw new PayloadError("meet_link is required.", "meet_link");
  if (!MEET_URL.test(meetLink)) {
    throw new PayloadError(
      `"${meetLink}" is not a Google Meet link. Expected https://meet.google.com/xxx-yyyy-zzz.`,
      "meet_link",
    );
  }

  const preContext = normalisePreContext(
    pick(body, ["pre_context", "preContext", "context", "briefing"]),
  );
  const credentials = normaliseCredentials(
    pick(body, ["bot_credentials", "botCredentials", "credentials"]),
  );

  return {
    teamId,
    // Only ever used to label a team row we could not resolve; never trusted.
    teamName: text(pick(body, ["team_name", "teamName"])) ?? null,
    meetLink,
    preContext,
    credentials,
    /** Everything the caller sent that we did not name. Logged, never obeyed. */
    extras: Object.keys(body).filter(
      (key) =>
        ![
          "team_id", "teamId", "workspace_id", "team",
          "meet_link", "meetLink", "meeting_url", "url",
          "pre_context", "preContext", "context", "briefing",
          "bot_credentials", "botCredentials", "credentials",
          "team_name", "teamName",
        ].includes(key),
    ),
  };
}
