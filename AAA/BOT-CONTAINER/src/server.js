import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { config, configWarnings, missingConfig } from "./config.js";
import { log, redact } from "./log.js";
import { PayloadError, parseSummon } from "./payload.js";
import { ping } from "./db.js";
import {
  BotSession,
  activeCount,
  getSession,
  listSessions,
  allSessions,
  reapSessions,
  registerSession,
  stopAll,
} from "./session.js";

/**
 * The container's API.
 *
 *   POST /api/start-bot        summon a bot into a meeting
 *   GET  /api/sessions         every session this container knows about
 *   GET  /api/sessions/:id     one session
 *   POST /api/sessions/:id/stop  make the bot leave
 *   GET  /health               liveness + Supabase reachability
 *
 * ---------------------------------------------------------------------------
 * WHY /api/start-bot RETURNS 202 AND NOT 200
 * ---------------------------------------------------------------------------
 * A meeting lasts as long as a meeting lasts. Holding the HTTP connection open
 * for it would time out at every proxy between the extension and here, and the
 * caller would be told the bot failed while it was sitting happily in the call.
 *
 * So the request does only the work that can fail *quickly and usefully*:
 * validate the payload, resolve the team, open the meeting row. If any of that
 * is wrong the caller gets a real error it can show a human. Everything after —
 * launching the browser, joining, transcribing — runs detached, and its
 * progress is read from `/api/sessions/:id`.
 */

const app = express();

// A Playwright storage state with a full Google cookie jar is comfortably over
// Express's 100kb default, and the resulting 413 is opaque.
app.use(express.json({ limit: "8mb" }));
app.disable("x-powered-by");

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
/**
 * The caller is a Chrome extension, whose origin (`chrome-extension://<id>`)
 * contains an install id that differs on every machine the extension is loaded
 * unpacked on. It therefore cannot be written into an allow-list in advance,
 * which is why the default here is `*` and why BOT_API_TOKEN — not the origin —
 * is what actually protects the endpoint.
 */
function corsOrigin(request) {
  const origin = request.headers.origin;
  if (config.allowedOrigins === "*") return origin ?? "*";
  const allowed = config.allowedOrigins.split(",").map((o) => o.trim());
  return origin && allowed.includes(origin) ? origin : null;
}

app.use((request, response, next) => {
  const origin = corsOrigin(request);
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }
  response.setHeader("access-control-allow-headers", "authorization, content-type, x-astra-token");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-max-age", "86400");
  if (request.method === "OPTIONS") return response.status(204).end();
  next();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
/**
 * Optional shared secret, accepted in either header.
 *
 * The extension already sends a Supabase access token as `Authorization:
 * Bearer`, so `x-astra-token` exists to let both travel on the same request
 * without one clobbering the other.
 *
 * Note what this is not: it is not proof that the caller leads the team. That
 * check lives in the dashboard, which has the user's session and the RLS
 * policies to enforce it. This container trusts whoever holds the secret.
 */
function authorise(request, response) {
  if (!config.apiToken) return true;
  const bearer = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const header = (request.headers["x-astra-token"] ?? "").trim();
  if (bearer === config.apiToken || header === config.apiToken) return true;
  response.status(401).json({
    status: "error",
    error: "Unauthorised. Send BOT_API_TOKEN as `x-astra-token` or a bearer token.",
  });
  return false;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", async (_request, response) => {
  const db = await ping().catch((error) => ({ ok: false, error: error.message }));
  response.status(db.ok ? 200 : 503).json({
    status: db.ok ? "ok" : "degraded",
    service: "astra-bot-container",
    supabase: db,
    gemini_model: config.geminiModel,
    sessions: { active: activeCount(), total: listSessions().length, max: config.maxSessions },
    headless: config.headless,
    uptime_seconds: Math.round(process.uptime()),
  });
});

app.post("/api/start-bot", async (request, response) => {
  if (!authorise(request, response)) return;

  let summon;
  try {
    summon = parseSummon(request.body);
  } catch (error) {
    if (error instanceof PayloadError) {
      return response.status(400).json({ status: "error", field: error.field, error: error.message });
    }
    throw error;
  }

  if (activeCount() >= config.maxSessions) {
    return response.status(429).json({
      status: "error",
      error:
        `This container is already running ${activeCount()} meeting(s), which is its ` +
        `limit (BOT_MAX_SESSIONS=${config.maxSessions}). Each one is a real browser.`,
    });
  }

  // The four core parameters, named, so a summon that goes wrong can be
  // diagnosed from the log alone. Never the cookie values — see log.js.
  log.info("summon received", {
    team_id: summon.teamId,
    meet_link: summon.meetLink,
    pre_context: { format: "markdown", chars: summon.preContext.length },
    bot_credentials: redact(
      summon.credentials.mode === "storage_state" ? summon.credentials.storageState : summon.credentials,
    ),
    ignored_fields: summon.extras,
  });

  if (summon.extras.length) {
    log.debug(`ignoring unrecognised field(s): ${summon.extras.join(", ")}`);
  }
  if (!summon.preContext) {
    log.warn("no pre_context in the payload — the bot will answer without sprint knowledge");
  }
  if (summon.credentials.mode === "guest") {
    log.warn("no usable bot credentials — the bot will ask to join as a guest and needs admitting");
  }

  await dumpPayload(request.body).catch((error) => log.warn("payload dump failed", error.message));

  const session = new BotSession(summon);
  registerSession(session);
  reapSessions();

  try {
    // Awaited on purpose: these are the failures worth reporting in the HTTP
    // response, because they are the ones a caller can do something about.
    await session.prepare();
  } catch (error) {
    session.status = "failed";
    session.error = error.message;
    log.error("could not start the session", error);
    return response.status(502).json({ status: "error", error: error.message });
  }

  // Detached. The meeting outlives this request by design.
  session.run().catch((error) => log.error("session crashed", error));

  response.status(202).json({
    status: "accepted",
    message: `Astra is joining ${summon.meetLink}.`,
    session_id: session.id,
    meeting: { id: session.meeting.id, number: session.meeting.meeting_number },
    team: {
      id: session.team.id,
      ref: session.team.ref,
      name: session.team.name,
      description: session.team.description,
    },
    poll: `/api/sessions/${session.id}`,
  });
});

/**
 * `GET /api/sessions?meet_link=…&active=1`
 *
 * The filters exist for one specific caller: the extension popup, whose entire
 * state is destroyed every time it closes. Without a way to ask "is there
 * already a bot in *this* meeting?", reopening the popup would offer to summon
 * a second one into a room that already has one.
 *
 * Answering it from the container rather than from `chrome.storage` is
 * deliberate — the container is the only thing that actually knows. A session id
 * remembered in the browser goes stale the moment the bot leaves, is wrong after
 * a container restart, and is missing entirely if someone summoned the bot from
 * a different profile or machine.
 */
app.get("/api/sessions", (request, response) => {
  if (!authorise(request, response)) return;

  const meetLink = String(request.query.meet_link ?? "").trim();
  const activeOnly = request.query.active === "1";

  let sessions = listSessions();
  if (meetLink) {
    // Meet appends things like ?authuser=1; compare the room, not the URL.
    const room = meetLink.split("?")[0];
    sessions = sessions.filter((s) => s.meet_link.split("?")[0] === room);
  }
  if (activeOnly) {
    sessions = sessions.filter((s) => !["ended", "failed"].includes(s.status));
  }

  response.json({ status: "ok", sessions });
});

app.get("/api/sessions/:id", (request, response) => {
  if (!authorise(request, response)) return;
  const session = getSession(request.params.id);
  if (!session) return response.status(404).json({ status: "error", error: "No such session." });
  response.json({ status: "ok", session: session.describe() });
});

/**
 * `GET /api/sessions/:id/transcript` — what the bot has heard, in order.
 * `GET /api/transcript` — the same, for the newest live session.
 *
 * This exists because "is it hearing anything?" is the question people actually
 * have while a meeting is running, and the previous answer was "grep the docker
 * log" — which fails for a reason that has nothing to do with the bot: `grep`
 * block-buffers when its stdout is a pipe rather than a terminal, so
 * `docker compose logs -f | grep 📝` sits silent until 4KB of matches pile up.
 * A quiet standup never reaches 4KB, and the bot looks broken when it is not.
 *
 * `?format=text` returns plain text, so it is readable straight from a terminal
 * with no jq.
 */
function transcriptHandler(request, response, session) {
  const limit = Math.min(Number(request.query.limit) || 100, 400);
  const lines = session.transcriptView({ limit });

  if (request.query.format === "text") {
    response.type("text/plain");
    if (!lines.length) {
      // An empty transcript is ambiguous on its own — silent room, or deaf bot?
      // The two facts that separate them go in the reply.
      return response.send(
        `no captions yet — status=${session.status}, ` +
          `captions_enabled=${session.captionsEnabled}\n`,
      );
    }
    const body = lines
      .map(
        (l) =>
          `${l.at.slice(11, 19)}  ${String(l.kind).padEnd(8)} ` +
          `${String(l.speaker).padEnd(14)} » ${l.text}`,
      )
      .join("\n");
    return response.send(body + "\n");
  }

  response.json({
    status: "ok",
    session_id: session.id,
    session_status: session.status,
    captions_enabled: session.captionsEnabled,
    counts: session.counts,
    lines,
  });
}

app.get("/api/sessions/:id/transcript", (request, response) => {
  if (!authorise(request, response)) return;
  const session = getSession(request.params.id);
  if (!session) return response.status(404).json({ status: "error", error: "No such session." });
  transcriptHandler(request, response, session);
});

app.get("/api/transcript", (request, response) => {
  if (!authorise(request, response)) return;
  // Newest first: during a meeting there is normally exactly one, and this
  // saves having to find its id before you can look at it.
  const live = [...allSessions()]
    .filter((s) => !["ended", "failed"].includes(s.status))
    .pop();
  const session = live ?? [...allSessions()].pop();
  if (!session) {
    return response
      .status(404)
      .json({ status: "error", error: "No sessions yet. Summon a bot first." });
  }
  transcriptHandler(request, response, session);
});

app.post("/api/sessions/:id/stop", (request, response) => {
  if (!authorise(request, response)) return;
  const session = getSession(request.params.id);
  if (!session) return response.status(404).json({ status: "error", error: "No such session." });
  session.stop("stop requested over the API");
  response.json({ status: "ok", session: session.describe() });
});

app.use((_request, response) => {
  response.status(404).json({
    status: "error",
    error: "Not found. This container serves POST /api/start-bot, GET /api/sessions and GET /health.",
  });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((error, _request, response, _next) => {
  log.error("unhandled error", error);
  response.status(500).json({ status: "error", error: error.message });
});

// ---------------------------------------------------------------------------
// Payload capture (off by default)
// ---------------------------------------------------------------------------
/**
 * ⚠ A dumped payload contains a live Google session. It is written only when
 * BOT_DUMP_PAYLOADS=1, and `data/` is gitignored. This is a debugging aid for
 * Phase 1 and should be off in anything resembling production.
 */
async function dumpPayload(body) {
  if (!config.dumpPayloads) return;
  const dir = path.join(config.dataDir, "payloads");
  await mkdir(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify({ received_at: new Date().toISOString(), body }, null, 2));
  log.debug(`payload written to ${file}`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const problems = missingConfig();
if (problems.length) {
  log.error(
    `Refusing to start: ${problems.join(", ")} ${problems.length === 1 ? "is" : "are"} not set. ` +
      "Copy .env.example to .env and fill it in — see ENVIRONMENT.md.",
  );
  process.exit(1);
}
for (const warning of configWarnings()) log.warn(warning);

const server = app.listen(config.port, config.host, () => {
  log.info(`astra-bot-container listening on http://${config.host}:${config.port}`);
  log.info(`  POST /api/start-bot   — summon a bot (team_id, meet_link, pre_context, bot_credentials)`);
  log.info(`  GET  /api/transcript?format=text — what the bot is hearing, right now`);
  log.info(`  GET  /health          — liveness and Supabase reachability`);
  log.info(`  model: ${config.geminiModel} · headless: ${config.headless} · max sessions: ${config.maxSessions}`);
});

/**
 * A bot in a meeting must not be killed mid-sentence: on SIGTERM the sessions
 * are asked to leave, which flushes the caption buffer, drains the transcript
 * queue and posts the meeting summary. Docker's ten-second default grace period
 * is too short for that, hence `stop_grace_period` in docker-compose.yml.
 */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info(`${signal} — asking ${activeCount()} session(s) to leave their calls`);
    server.close();
    await stopAll(`${signal} received`);
    // Give the sessions a moment to flush before the process goes.
    setTimeout(() => process.exit(0), 20_000).unref?.();
  });
}

process.on("unhandledRejection", (error) => log.error("unhandled rejection", error));
