import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every knob the container has, read once at boot.
 *
 * Two rules here, and they are the reason this file exists rather than a
 * scattering of `process.env` reads:
 *
 *  1. **Fail loudly at boot, not silently at 09:03 in a standup.** A missing
 *     GEMINI_API_KEY should stop the server starting, not surface twenty
 *     minutes later as a bot that joined, transcribed, and then said nothing
 *     when someone asked it a question.
 *
 *  2. **Every default is a working default.** `docker compose up` with only the
 *     three required secrets set must produce a bot that joins and answers.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function str(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : String(value).trim();
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a whole number; got ${JSON.stringify(raw)}.`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** Comma-separated list -> trimmed, lowercased, de-duplicated array. */
function list(name, fallback) {
  const raw = str(name);
  const source = raw ? raw.split(",") : fallback;
  return [...new Set(source.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
}

export const config = {
  // -- HTTP ----------------------------------------------------------------
  port: int("PORT", 3001),
  // 0.0.0.0 inside a container, because binding to localhost there means
  // "reachable only from inside the container" -- the published port then
  // connects to nothing, which looks exactly like a crashed server.
  host: str("HOST", "0.0.0.0"),

  /**
   * Optional shared secret. When set, /api/start-bot requires it in either
   * `Authorization: Bearer <token>` or `x-astra-token`.
   *
   * Left unset the endpoint is open, which is fine on a laptop bound to
   * localhost and is NOT fine anywhere else -- the server says so at boot.
   */
  apiToken: str("BOT_API_TOKEN"),

  /**
   * Origins allowed to call this API. `chrome-extension://*` is the interesting
   * one: an extension's origin contains its install id, which differs on every
   * developer's machine, so it cannot be listed literally.
   */
  allowedOrigins: str("ALLOWED_ORIGINS", "*"),

  // -- Supabase ------------------------------------------------------------
  supabaseUrl: str("SUPABASE_URL"),
  // The SERVICE ROLE key, not the anon key. The container writes transcripts
  // for meetings it is not a member of, and it has no user session to be
  // filtered by RLS against.
  supabaseServiceRoleKey: str("SUPABASE_SERVICE_ROLE_KEY"),

  // -- Gemini --------------------------------------------------------------
  geminiApiKey: str("GEMINI_API_KEY"),
  /**
   * An alias, not a pinned version, and deliberately so.
   *
   * Google retires models on its own schedule -- `gemini-2.0-flash`, the
   * previous default here, started answering 404 with "no longer available".
   * A pinned id turns that into a bot that joins the standup and cannot speak.
   * The alias tracks whatever the current Flash is, which is the right trade
   * for a meeting assistant: newest-and-working beats reproducible-and-dead.
   *
   * Pin a specific id here if you need byte-stable answers, and put a calendar
   * reminder on it.
   *
   * Avoid the "thinking" models (gemini-3.6-flash and friends) unless you also
   * raise GEMINI_MAX_OUTPUT_TOKENS: reasoning tokens come out of the same
   * budget, and answers arrive truncated mid-sentence.
   */
  geminiModel: str("GEMINI_MODEL", "gemini-flash-latest"),
  geminiBaseUrl: str("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"),
  geminiTimeoutMs: int("GEMINI_TIMEOUT_MS", 30_000),
  /** Meet chat is a chat box, not a document. Keep answers short by contract. */
  geminiMaxOutputTokens: int("GEMINI_MAX_OUTPUT_TOKENS", 512),

  // -- Browser -------------------------------------------------------------
  headless: bool("BOT_HEADLESS", true),

  /**
   * The User-Agent the bot presents.
   *
   * Playwright's headless Chromium advertises `HeadlessChrome/...` by default.
   * That does not on its own get a session rejected -- a dead session is dead
   * under either string -- but it is a standing signal to Google that this is
   * not a person, and signals like that shorten how long an exported session
   * survives. Presenting an ordinary desktop Chrome costs nothing.
   */
  userAgent: str(
    "BOT_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ),

  /**
   * When Google refuses the saved session, join as a guest rather than give up.
   *
   * A guest bot has to be admitted by a human and joins under BOT_DISPLAY_NAME,
   * but it still captions, still transcribes and still answers -- which is a
   * great deal better than a standup with no notetaker because a cookie went
   * stale overnight. Set to 0 to make a dead session a hard failure.
   */
  allowGuestFallback: bool("BOT_ALLOW_GUEST_FALLBACK", true),

  /** Probe the Google session before opening the meeting. */
  verifySession: bool("BOT_VERIFY_SESSION", true),
  /** Only used for a guest join; a signed-in join carries the account's name. */
  displayName: str("BOT_DISPLAY_NAME", "Astra Notetaker"),
  joinTimeoutMs: int("BOT_JOIN_TIMEOUT_MS", 45_000),
  /** How long to sit in the lobby waiting to be admitted. */
  admitTimeoutMs: int("BOT_ADMIT_TIMEOUT_MS", 300_000),
  /** Hang up after this long alone in the room. 0 disables. */
  aloneLeaveMs: int("BOT_ALONE_LEAVE_MS", 120_000),
  /** Hard ceiling on a single meeting, so a forgotten bot cannot run all week. */
  maxMeetingMs: int("BOT_MAX_MEETING_MS", 4 * 60 * 60 * 1000),
  captionLanguage: str("BOT_CAPTION_LANGUAGE", ""),

  // -- Wake word and buffering ---------------------------------------------
  wakeWords: list("BOT_WAKE_WORDS", ["hey astra", "ok astra", "astra"]),
  completionPhrases: list("BOT_COMPLETION_PHRASES", [
    "that's all",
    "thats all",
    "that's it",
    "thats it",
    "over to you",
    "thank you astra",
    "end of question",
  ]),
  /** The spec's 5-second silence threshold. */
  silenceMs: int("BOT_SILENCE_MS", 5_000),
  /** A wake word with nothing after it is a false positive, not a question. */
  minQueryChars: int("BOT_MIN_QUERY_CHARS", 3),

  // -- The conversation protocol --------------------------------------------
  /**
   * What the bot says the instant it hears its name, before it knows the
   * question. Answering "..." for eight seconds while somebody talks is
   * indistinguishable from a bot that did not hear them, and they start again.
   */
  greeting: str("BOT_GREETING", "Yeah, how can I help you?"),

  /**
   * Let the bot be dry and occasionally funny.
   *
   * Constrained rather than free rein: the humour never precedes the answer,
   * never lands on a named person, and is dropped entirely when the news is
   * bad. Somebody who is blocked or behind is sitting in that room reading the
   * chat, and a bot being witty about it is the fastest way to get it thrown
   * out of the standup. Set BOT_HUMOUR=0 for a plain, serious assistant.
   */
  humour: bool("BOT_HUMOUR", true),

  /**
   * Echo the question back and wait for a yes/no before spending a model call.
   *
   * OFF by default. The reason it existed was that captions mishear names and
   * jargon, and an answer to a misheard question is confidently wrong in front
   * of the room. That risk is real -- but making somebody say "yes" out loud to
   * a robot, mid-standup, to unlock an answer is a worse cure than the disease.
   *
   * The answer now opens by restating the question in a few words ("Since you
   * asked about the auth PR..."), which shows the room what was heard *and*
   * answers it in one message. The check survives; the interruption does not.
   *
   * Set BOT_CONFIRM=1 to bring the explicit yes/no back -- worth it in a noisy
   * room, or where a wrong answer is expensive.
   */
  confirmEnabled: bool("BOT_CONFIRM", false),
  /** How long to wait for a yes/no before going ahead anyway. */
  confirmTimeoutMs: int("BOT_CONFIRM_TIMEOUT_MS", 7_000),
  yesWords: list("BOT_YES_WORDS", [
    "yes", "yeah", "yep", "yup", "ya", "correct", "right", "that's right",
    "thats right", "exactly", "go ahead", "sure", "please", "affirmative",
  ]),
  noWords: list("BOT_NO_WORDS", [
    "no", "nope", "nah", "not really", "wrong", "that's wrong", "thats wrong",
    "incorrect", "not quite", "negative",
  ]),
  rejectedReply: str(
    "BOT_REJECTED_REPLY",
    "My mistake — say \"Hey Astra\" and ask me again.",
  ),

  // -- In-memory context ----------------------------------------------------
  /** Past [query, answer] turns kept for follow-ups. Pairs, not messages. */
  maxContextTurns: int("BOT_MAX_CONTEXT_TURNS", 12),
  /** Characters of pre-context passed to the model. Guards a runaway payload. */
  maxPreContextChars: int("BOT_MAX_PRECONTEXT_CHARS", 24_000),

  // -- Chat output ----------------------------------------------------------
  /** Meet rejects very long chat messages; stay well inside the limit. */
  chatChunkChars: int("BOT_CHAT_CHUNK_CHARS", 900),
  chatMaxChunks: int("BOT_CHAT_MAX_CHUNKS", 3),

  // -- Concurrency and disk --------------------------------------------------
  maxSessions: int("BOT_MAX_SESSIONS", 3),
  dataDir: path.resolve(ROOT, str("BOT_DATA_DIR", "data")),
  /** Write each accepted payload to data/payloads/. Off by default: it holds
   *  a live Google session. */
  dumpPayloads: bool("BOT_DUMP_PAYLOADS", false),
  /**
   * Dump the caption region to data/debug/ when nothing has been heard.
   *
   * The one failure this catches that nothing else does: Google rotates its
   * obfuscated class names, the observer matches nothing, and the bot sits in
   * the meeting transcribing silence with no error anywhere.
   */
  debugCaptions: bool("BOT_DEBUG_CAPTIONS", true),
  captionDiagnosticMs: int("BOT_CAPTION_DIAGNOSTIC_MS", 90_000),

  /** Screenshots when the join or the caption toggle goes wrong. */
  debugShots: bool("BOT_DEBUG_SHOTS", true),

  /**
   * Print every finalised caption line at info level.
   *
   * On by default because the first question asked of a transcription bot that
   * looks wrong is always "what did it actually hear?", and burying that behind
   * LOG_LEVEL=debug means also turning on every other debug line to find it.
   */
  logTranscript: bool("BOT_LOG_TRANSCRIPT", true),

  /** Lines kept in memory for GET /api/sessions/:id/transcript. */
  transcriptBuffer: int("BOT_TRANSCRIPT_BUFFER", 400),

  /** Print a marker for every row written to Supabase, with its latency. */
  logDbWrites: bool("BOT_LOG_DB", true),

  logLevel: str("LOG_LEVEL", "info"),
  root: ROOT,
};

/**
 * What is missing, in the order it will bite you.
 *
 * Returned rather than thrown so the caller can decide: the server refuses to
 * start on a hard failure, but `--check` prints the list and exits 0.
 */
export function missingConfig() {
  const problems = [];
  if (!config.supabaseUrl) problems.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) problems.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!config.geminiApiKey) problems.push("GEMINI_API_KEY");
  return problems;
}

/** Non-fatal things worth saying out loud once, at boot. */
export function configWarnings() {
  const warnings = [];
  if (!config.apiToken) {
    warnings.push(
      "BOT_API_TOKEN is not set, so /api/start-bot accepts any caller. That is " +
        "fine bound to localhost and unsafe on a reachable network.",
    );
  }
  if (config.allowedOrigins === "*" && config.apiToken) {
    warnings.push("ALLOWED_ORIGINS is '*'; the shared secret is what is protecting you.");
  }
  if (!config.headless) {
    warnings.push("BOT_HEADLESS=0 — a real browser window will open. Never do this in Docker.");
  }
  if (config.supabaseServiceRoleKey && config.supabaseServiceRoleKey.length < 40) {
    warnings.push("SUPABASE_SERVICE_ROLE_KEY looks too short — is that the anon key?");
  }
  return warnings;
}
