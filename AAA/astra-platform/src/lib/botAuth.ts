import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Server-side driver for the Team Leader's Google bot session.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS LOCAL-ONLY, AND WHAT PHASE 2 CHANGES
 * ---------------------------------------------------------------------------
 * Authenticating the bot means opening a **headful** Chromium so a human can
 * complete Google's sign-in, 2FA and device checks by hand. That imposes two
 * requirements a deployed server cannot meet: a display, and the leader sitting
 * in front of it. So in Phase 1 this runs where `npm run dev` runs — the
 * leader's own machine — and the resulting session is written to
 *
 *     ../astra-extras/bot-auth/secrets/leaders/{user_id}/auth.json
 *
 * PHASE 2: that file is uploaded to Supabase Storage under the key
 *     leaders/{user_id}/auth.json
 * in a private bucket, and the bot container downloads it at launch with a
 * signed URL instead of having it bind-mounted. The on-disk layout here already
 * mirrors those keys so the migration is a copy rather than a rename. The
 * upload belongs in `finishRun()` below, where the run is known to have
 * succeeded and the file is known to be good.
 *
 * Because this spawns a process on the server host, it is gated twice: the
 * caller must be signed in, and the deployment must explicitly opt in with
 * ASTRA_ALLOW_LOCAL_BOT_AUTH=1. On a real server the flag stays unset and the
 * route returns a clear explanation rather than hanging on a browser that can
 * never appear.
 */

export const BOT_AUTH_ENABLED_ENV = "ASTRA_ALLOW_LOCAL_BOT_AUTH";

/** Repository-relative home of the Playwright script and its output. */
function botAuthDir(): string {
  return path.resolve(process.cwd(), "../astra-extras/bot-auth");
}

export function leaderPaths(userId: string) {
  const dir = path.join(botAuthDir(), "secrets", "leaders", userId);
  return {
    dir,
    auth: path.join(dir, "auth.json"),
    meta: path.join(dir, "meta.json"),
    // PHASE 2: the Supabase Storage object key this file moves to.
    storageKey: `leaders/${userId}/auth.json`,
  };
}

/** Whether the local flow is permitted in this deployment. */
export function localBotAuthEnabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env[BOT_AUTH_ENABLED_ENV] === "1";
}

export type BotAuthState = "none" | "authenticated" | "expired" | "failed";

export interface BotAuthStatus {
  state: BotAuthState;
  googleEmail: string | null;
  cookieCount: number | null;
  /** Earliest expiry among the Google auth cookies. */
  expiresAt: string | null;
  updatedAt: string | null;
  /** Phase 1: a local path. Phase 2: the Storage key. */
  storagePath: string | null;
  error: string | null;
  /** True when the file exists on this machine right now. */
  filePresent: boolean;
}

const EMPTY: BotAuthStatus = {
  state: "none",
  googleEmail: null,
  cookieCount: null,
  expiresAt: null,
  updatedAt: null,
  storagePath: null,
  error: null,
  filePresent: false,
};

interface MetaFile {
  status?: string;
  google_email?: string | null;
  cookie_count?: number | null;
  expires_at?: string | null;
  storage_path?: string | null;
  error?: string | null;
  /** Why the last sign-in attempt failed, even if the credential is fine. */
  last_run_error?: string | null;
  updated_at?: string | null;
  signed_in?: boolean;
}

/**
 * Reads the on-disk status for one leader.
 *
 * Deliberately reads `meta.json` and not `auth.json`: answering "is the bot
 * ready?" should never involve opening a file full of live Google cookies. The
 * existence of auth.json is confirmed separately with a `stat`, so a meta file
 * left behind by a deleted session cannot report success.
 */
export async function readBotAuthStatus(userId: string): Promise<BotAuthStatus> {
  if (!localBotAuthEnabled()) return { ...EMPTY };
  const paths = leaderPaths(userId);

  const filePresent = await stat(paths.auth).then(
    () => true,
    () => false,
  );

  let meta: MetaFile | null = null;
  try {
    meta = JSON.parse(await readFile(paths.meta, "utf8")) as MetaFile;
  } catch {
    meta = null; // never authenticated on this machine, or the file was removed
  }

  if (!meta) {
    return { ...EMPTY, filePresent, storagePath: filePresent ? paths.auth : null };
  }

  // The FILE is the credential; the metadata is only a label for it. So the
  // filesystem decides, in both directions:
  //
  //   - Someone deleting auth.json by hand must not leave the dashboard
  //     reporting a bot that is gone.
  //   - A sign-in someone abandoned halfway must not demote the perfectly good
  //     session that was already there. `signed_in` is written from the actual
  //     file, so it outranks a `failed` run status. This is the bug where
  //     Settings said one thing and every team page said another.
  const fileHasSession = filePresent && meta.signed_in === true;

  let state: BotAuthState = fileHasSession
    ? "authenticated"
    : meta.status === "authenticated" && filePresent
      ? "authenticated"
      : meta.status === "failed"
        ? "failed"
        : filePresent
          ? "expired"
          : "none";

  // A cookie expiry in the past is expiry, whatever the file says about itself.
  if (state === "authenticated" && meta.expires_at) {
    if (Date.parse(meta.expires_at) < Date.now()) state = "expired";
  }

  return {
    state,
    googleEmail: meta.google_email ?? null,
    cookieCount: meta.cookie_count ?? null,
    expiresAt: meta.expires_at ?? null,
    updatedAt: meta.updated_at ?? null,
    storagePath: meta.storage_path ?? (filePresent ? paths.auth : null),
    // Not surfaced as a failure when the credential itself is healthy.
    error: state === "authenticated" ? null : (meta.error ?? meta.last_run_error ?? null),
    filePresent,
  };
}

/** Remove a leader's local credentials entirely. */
export async function deleteBotAuth(userId: string): Promise<void> {
  if (!localBotAuthEnabled()) {
    throw new BotAuthError(503, "Manage local bot credentials from Astra running on your own machine.");
  }
  // PHASE 2: also delete the Supabase Storage object at
  // `leaders/{user_id}/auth.json`, otherwise revoking locally would leave a
  // usable session in the bucket.
  await rm(leaderPaths(userId).dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The run registry
// ---------------------------------------------------------------------------

export type RunState = "running" | "succeeded" | "failed";

export interface AuthRun {
  userId: string;
  state: RunState;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  /** Tail of the script's own output, shown in the UI while it runs. */
  log: string[];
  child: ChildProcess | null;
}

/**
 * One run per leader at a time, held in module scope.
 *
 * In-memory is the right scope here precisely because the flow is local: the
 * browser window belongs to this machine and this Node process, and a run that
 * outlived a server restart would be a run whose window nobody can find. A
 * restart simply loses the job, and the file on disk remains the source of
 * truth for whether it worked.
 */
const runs = new Map<string, AuthRun>();

const MAX_LOG_LINES = 80;
/** Google sign-in with 2FA is slow, but not this slow. */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

export function getRun(userId: string): AuthRun | null {
  return runs.get(userId) ?? null;
}

export class BotAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Launches the Playwright script for this leader.
 *
 * The user id is passed as a separate argv entry to a real executable — never
 * interpolated into a shell string — and the script validates it as a UUID
 * before using it as a directory name. Two independent checks, because this
 * value ends up as a filesystem path.
 */
export function startBotAuth(userId: string): AuthRun {
  if (!localBotAuthEnabled()) {
    throw new BotAuthError(
      503,
      "Bot authentication is disabled on this server. It opens a real browser " +
        "window for you to sign in to, so it only works when Astra is running " +
        "on your own machine. Set " +
        `${BOT_AUTH_ENABLED_ENV}=1 in .env.local and restart \`npm run dev\`.`,
    );
  }

  const existing = runs.get(userId);
  if (existing?.state === "running") {
    throw new BotAuthError(
      409,
      "A sign-in window is already open for your account. Finish it, or close " +
        "the browser window, before starting another.",
    );
  }

  const python = process.env.ASTRA_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const script = path.join(botAuthDir(), "generate_google_auth.py");

  const child = spawn(python, [script, "--user-id", userId, "--force"], {
    cwd: botAuthDir(),
    // The script waits on stdin for Enter, but it also finishes on its own once
    // the session cookie appears or the window closes. Giving it an ignored
    // stdin means it sees EOF and relies on those, which is what we want from a
    // web trigger — there is no terminal for anyone to press Enter in.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  const run: AuthRun = {
    userId,
    state: "running",
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    log: [],
    child,
  };
  runs.set(userId, run);

  const append = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      run.log.push(trimmed);
      if (run.log.length > MAX_LOG_LINES) run.log.shift();
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const timer = setTimeout(() => {
    if (run.state === "running") {
      run.log.push("[astra] timed out after 15 minutes; closing the browser.");
      child.kill();
    }
  }, RUN_TIMEOUT_MS);

  child.on("error", (error) => {
    clearTimeout(timer);
    run.state = "failed";
    run.finishedAt = Date.now();
    run.log.push(
      `[astra] could not start Python (${error.message}). Set ASTRA_PYTHON to ` +
        "the interpreter that has Playwright installed.",
    );
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    run.exitCode = code;
    run.state = code === 0 ? "succeeded" : "failed";
    run.finishedAt = Date.now();
    run.child = null;
    // PHASE 2: on success, upload
    //   ../astra-extras/bot-auth/secrets/leaders/{userId}/auth.json
    // to Supabase Storage as `leaders/{userId}/auth.json` in a private bucket,
    // then record the returned object key as `storage_path`. Doing it here,
    // rather than in the route, means it happens exactly once per successful
    // run and is not tied to the request that started it.
  });

  return run;
}

/** Cancel a run in progress — closes the browser window the leader left open. */
export function cancelBotAuth(userId: string): boolean {
  const run = runs.get(userId);
  if (!run || run.state !== "running" || !run.child) return false;
  run.child.kill();
  run.log.push("[astra] cancelled.");
  return true;
}

/** The serialisable view of a run, for the polling endpoint. */
export function describeRun(run: AuthRun | null) {
  if (!run) return null;
  return {
    state: run.state,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    exitCode: run.exitCode,
    elapsedMs: (run.finishedAt ?? Date.now()) - run.startedAt,
    log: run.log.slice(-25),
  };
}
