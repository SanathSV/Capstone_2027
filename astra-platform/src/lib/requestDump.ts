import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Writes every payload the Chrome extension sends to a JSON file on disk.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ TEMPORARY — Phase 1 scaffolding. Delete this file when the bot        │
 * │ launcher is real. Removal recipe at the bottom of this comment.       │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * It exists for one reason: right now `/api/bot/summon` is a dummy that prints
 * and acknowledges, so the only way to see what the extension actually sends is
 * to keep a copy. Once the route launches a container, the container *is* the
 * consumer and these files are a second copy of a credential nobody reads.
 *
 * A deliberately literal artefact: the file is exactly what arrived, so it can
 * be inspected, diffed between runs, or fed straight into a bot container while
 * the launch pipeline is still being built.
 *
 * ⚠ THE FILE CONTAINS A LIVE GOOGLE SESSION.
 *
 * `bot_credentials` carries the same cookies as `auth.json`, so anyone holding
 * one of these files is signed in as the bot account with no password and no
 * second factor. Three things guard that:
 *
 *   1. The directory is gitignored twice — in the project's .gitignore and by
 *      a `*` .gitignore written inside the directory itself, so it stays
 *      ignored even if the folder is moved or the root file is edited.
 *   2. Every write prints the path, so the files are never a surprise.
 *   3. `ASTRA_DUMP_REDACT=1` replaces cookie values with a placeholder while
 *      keeping every other field, for when the payload is being shared or
 *      screenshotted.
 *
 * Set `ASTRA_DUMP_REQUESTS=0` to turn the whole thing off.
 *
 * ---------------------------------------------------------------------------
 * TO REMOVE IT, when Phase 2 lands:
 *
 *   1. Delete this file.
 *   2. In `src/app/api/bot/summon/route.ts`: drop the `writeSummonDump` import,
 *      the `const dump = await writeSummonDump({...})` block, the `if (dump)`
 *      log, and `saved_to` from the response.
 *   3. `rm -rf _sent_data_extension`
 *   4. Tidy `.gitignore` and the two `ASTRA_DUMP_*` lines in `.env.example`.
 *
 * Nothing else imports it, so that is the whole footprint.
 * ---------------------------------------------------------------------------
 */

const DIR_NAME = "_sent_data_extension";
/** Keep the directory browsable rather than letting it grow without bound. */
const KEEP_FILES = 50;

export function dumpDir(): string {
  return path.join(process.cwd(), DIR_NAME);
}

export function dumpEnabled(): boolean {
  return process.env.ASTRA_DUMP_REQUESTS !== "0";
}

function redactEnabled(): boolean {
  return process.env.ASTRA_DUMP_REDACT === "1";
}

/**
 * Blanks cookie values, keeping names, domains and expiries.
 *
 * The shape is what makes a credential diagnosable — which cookies are present,
 * whose account, when they lapse — and none of that is the secret. The value is.
 */
function redactCredentials(creds: unknown): unknown {
  if (!creds || typeof creds !== "object") return creds;
  const record = creds as Record<string, unknown>;
  const cookies = record.cookies as Record<string, unknown>[] | undefined;
  if (!Array.isArray(cookies)) return creds;

  return {
    ...record,
    cookies: cookies.map((c) => ({
      ...c,
      value: "<redacted — unset ASTRA_DUMP_REDACT to capture the real value>",
    })),
    origins: "<redacted — localStorage may carry tokens too>",
  };
}

/** `Astra_dev` -> `astra-dev`, so filenames stay sortable and shell-safe. */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "team"
  );
}

/** Newest first, oldest deleted beyond KEEP_FILES. */
async function prune(dir: string): Promise<void> {
  try {
    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".json") && f !== "latest.json")
      .sort()
      .reverse();
    for (const stale of files.slice(KEEP_FILES)) {
      await rm(path.join(dir, stale), { force: true });
    }
  } catch {
    // Housekeeping must never fail the request that triggered it.
  }
}

export interface SummonDump {
  received_at: string;
  caller: { id: string; email: string | null; via: string };
  team: { id: string; name: string };
  meet_link: string;
  /** The four fields exactly as they arrived. */
  body: Record<string, unknown>;
  /** The same summaries the terminal log prints. */
  summary: Record<string, unknown>;
}

export interface DumpResult {
  path: string;
  bytes: number;
  redacted: boolean;
}

/**
 * Writes one request to `_sent_data_extension/`.
 *
 * Never throws: a dump is a debugging convenience, and failing to write one
 * must not fail the summon it was recording. Problems are logged instead.
 */
export async function writeSummonDump(dump: SummonDump): Promise<DumpResult | null> {
  if (!dumpEnabled()) return null;

  const dir = dumpDir();

  try {
    await mkdir(dir, { recursive: true });

    // Belt and braces: even if this directory is copied elsewhere, or the root
    // .gitignore is rewritten, git still refuses to stage what is in here.
    await writeFile(
      path.join(dir, ".gitignore"),
      [
        "# Everything in this directory is a captured request body, and every",
        "# one of them contains a live Google session. Never commit any of it.",
        "*",
        "!.gitignore",
        "!README.md",
        "",
      ].join("\n"),
      "utf8",
    );

    const redacted = redactEnabled();
    const body = redacted
      ? { ...dump.body, bot_credentials: redactCredentials(dump.body.bot_credentials) }
      : dump.body;

    // Two views of the same request, and both earn their place.
    //
    // `PRE_CONTEXT` is the readable one: the value the bot is briefed with,
    // named, with its format and size stated. Buried inside `body` as a single
    // escaped string it is unreadable, and "is this JSON or Markdown?" is the
    // first question anyone opening this file asks.
    //
    // `body` stays byte-for-byte what arrived on the wire, because the point of
    // a capture is that it is not editorialised. It costs ~1.8 KB to say the
    // pre-context twice; the credentials are not duplicated, since those are
    // twenty times the size and nobody reads them by eye.
    const preContext = body.pre_context;
    const isMarkdown = typeof preContext === "string";

    const record = {
      ...dump,
      PRE_CONTEXT: {
        format: isMarkdown ? "markdown" : preContext ? "json" : "missing",
        sent_as: "body.pre_context",
        bytes: isMarkdown ? Buffer.byteLength(preContext, "utf8") : null,
        tokens: isMarkdown ? Math.ceil(preContext.length / 4) : null,
        value: preContext ?? null,
      },
      BOT_CREDENTIALS: {
        // The value itself is in `body`; this is the shape, for reading.
        ...(dump.summary.bot_credentials as Record<string, unknown> | undefined),
        sent_as: "body.bot_credentials",
      },
      body,
      _note: redacted
        ? "Cookie values redacted (ASTRA_DUMP_REDACT=1)."
        : "CONTAINS A LIVE GOOGLE SESSION — treat this file like a password.",
    };

    // Colons are illegal in Windows filenames, so the timestamp is flattened.
    const stamp = dump.received_at.replace(/[:.]/g, "-");
    const name = `${stamp}__${slug(dump.team.name)}__${randomUUID().slice(0, 8)}.json`;
    const target = path.join(dir, name);
    const json = JSON.stringify(record, null, 2);

    await writeFile(target, json, "utf8");
    // A stable path for whatever consumes the most recent payload, so a script
    // does not have to glob and sort to find it.
    await writeFile(path.join(dir, "latest.json"), json, "utf8");

    await prune(dir);

    return { path: target, bytes: Buffer.byteLength(json, "utf8"), redacted };
  } catch (error) {
    console.error(
      `[astra:dump] could not write to ${dir}: ${(error as Error).message}`,
    );
    return null;
  }
}
