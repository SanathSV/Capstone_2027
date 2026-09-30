import { config } from "./config.js";

/**
 * Logging, with one non-obvious rule: a log line must never carry a credential.
 *
 * This process holds a live Google session for the length of a meeting. The
 * temptation to `console.log(payload)` while debugging is exactly how a cookie
 * jar ends up in a CI log, so the only thing that ever prints about credentials
 * is a count and a state — see `redact()`.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function emit(level, scope, message, extra) {
  if (LEVELS[level] > threshold) return;
  const tail = extra === undefined ? "" : ` ${format(extra)}`;
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${scope} ${message}${tail}`;
  // Everything to stderr except info-level narration, so `docker logs` stays
  // readable while a piped stdout stays a clean transcript.
  (level === "info" ? process.stdout : process.stderr).write(line + "\n");
}

function format(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Markers that make one kind of line greppable out of a busy log.
 *
 * A meeting produces a lot of operational noise, and the two things anyone
 * actually wants while debugging are "what did it hear?" and "did that reach
 * the database?". Prefixing those makes both a one-liner:
 *
 *     docker compose logs -f | grep 📝     # the live transcript
 *     docker compose logs -f | grep 💾     # every Supabase write
 *     docker compose logs   | grep '💾.*✗' # only the writes that failed
 */
export const MARK = {
  /** A finalised caption line — what the bot heard. */
  caption: "📝",
  /** A row going to, or landing in, Supabase. */
  db: "💾",
  /** A model call. */
  llm: "🧠",
  /** Something posted into the meeting chat. */
  chat: "💬",
};

/** A logger bound to one scope — usually a session id, so lines interleave readably. */
export function logger(scope) {
  return {
    error: (message, extra) => emit("error", scope, message, extra),
    warn: (message, extra) => emit("warn", scope, message, extra),
    info: (message, extra) => emit("info", scope, message, extra),
    debug: (message, extra) => emit("debug", scope, message, extra),
    child: (suffix) => logger(`${scope}${suffix}`),
  };
}

export const log = logger("[astra]");

/**
 * A description of a credentials blob that is safe to print.
 *
 * Never returns any cookie value, and never returns the password — only enough
 * to answer "did the bot get something it can actually sign in with?".
 */
export function redact(credentials) {
  if (!credentials || typeof credentials !== "object") {
    return { present: false, kind: "none" };
  }
  const cookies = Array.isArray(credentials.cookies) ? credentials.cookies : [];
  const google = cookies.filter((c) => String(c?.domain ?? "").includes("google"));
  return {
    present: true,
    kind: cookies.length ? "storage_state" : credentials.password ? "password" : "unknown",
    email: credentials.email ?? credentials.google_email ?? null,
    has_password: Boolean(credentials.password),
    cookies: cookies.length,
    google_cookies: google.length,
    origins: Array.isArray(credentials.origins) ? credentials.origins.length : 0,
  };
}
