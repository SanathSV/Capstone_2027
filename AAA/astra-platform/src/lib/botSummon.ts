/**
 * Summarising a summon request for the terminal.
 *
 * Split out of the route so it can be tested. The route's job is auth and
 * validation; this file's job is to describe what arrived without ever quoting
 * the credential — and "never quotes the credential" is a property worth having
 * an assertion for rather than a comment.
 */

/** The cookies that actually constitute a signed-in Google session. */
const GOOGLE_AUTH_COOKIES = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "LSID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-1PSIDTS",
]);

export interface ContextSummary {
  present: boolean;
  /** "markdown" when the payload arrived as prose rather than JSON. */
  format?: string;
  sections?: string[];
  table_rows?: number;
  team?: string;
  members?: number;
  open_prs?: number;
  commits?: number;
  sprint?: string;
  issues?: number;
  verdict?: string;
  risks?: number;
  talking_points?: number;
  tokens?: number;
  bytes?: number;
}

export interface CredentialSummary {
  present: boolean;
  state: string;
  account?: string;
  cookies_total?: number;
  google_cookies?: number;
  auth_cookies?: number;
  origins?: number;
  detail: string;
}

export function summarisePreContext(
  payload: Record<string, unknown> | string | null | undefined,
): ContextSummary {
  // Markdown is the normal case now. Describing it means measuring it and
  // reading its headings, since there are no fields to count.
  if (typeof payload === "string") {
    const headings = [...payload.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    const rows = (payload.match(/^\|/gm) ?? []).length;
    return {
      present: payload.trim().length > 0,
      format: "markdown",
      team: payload.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "unknown",
      sections: headings,
      table_rows: rows,
      bytes: Buffer.byteLength(payload, "utf8"),
      tokens: Math.ceil(payload.length / 4),
    };
  }

  if (!payload || typeof payload !== "object") return { present: false };

  const team = payload.team as { name?: string } | undefined;
  const roster = payload.roster as unknown[] | undefined;
  const github = payload.github as
    | { open_prs?: unknown[]; recent_commits?: unknown[] }
    | undefined;
  const jira = payload.jira as
    | { issues?: unknown[]; sprint?: { name?: string } }
    | undefined;
  const analysis = payload.analysis as
    | { sprint?: { verdict?: string }; risks?: unknown[]; talking_points?: unknown[] }
    | undefined;
  const meta = payload.meta as { token_estimate?: number; bytes?: number } | undefined;

  return {
    present: true,
    format: "json",
    team: team?.name ?? "unknown",
    members: roster?.length ?? 0,
    open_prs: github?.open_prs?.length ?? 0,
    commits: github?.recent_commits?.length ?? 0,
    sprint: jira?.sprint?.name ?? "none",
    issues: jira?.issues?.length ?? 0,
    verdict: analysis?.sprint?.verdict ?? "n/a",
    risks: analysis?.risks?.length ?? 0,
    talking_points: analysis?.talking_points?.length ?? 0,
    tokens: meta?.token_estimate ?? 0,
    bytes: meta?.bytes ?? 0,
  };
}

/**
 * Describes credentials without quoting them.
 *
 * Counting Google *auth* cookies rather than all cookies is the point: a
 * storage state full of analytics cookies and no SID is a signed-out session
 * wearing a costume, and "42 cookies" would report it as healthy.
 */
export function summariseCredentials(
  creds: Record<string, unknown> | null | undefined,
): CredentialSummary {
  if (!creds || typeof creds !== "object") {
    return { present: false, state: "missing", detail: "none supplied" };
  }

  const cookies =
    (creds.cookies as { name?: string; domain?: string }[] | undefined) ?? [];
  const google = cookies.filter((c) => String(c.domain ?? "").includes("google"));
  const auth = google.filter((c) => GOOGLE_AUTH_COOKIES.has(String(c.name)));

  return {
    present: true,
    state: auth.length > 0 ? "authenticated" : "present but signed out",
    account: (creds.google_email as string | undefined) ?? "unknown",
    cookies_total: cookies.length,
    google_cookies: google.length,
    auth_cookies: auth.length,
    origins: ((creds.origins as unknown[] | undefined) ?? []).length,
    detail:
      auth.length > 0
        ? `${auth.length} Google auth cookie(s) — the bot can join signed in`
        : "no Google auth cookies — the bot would join as an anonymous guest",
  };
}

/**
 * The four fields, as one block for the terminal.
 *
 * Returned rather than printed so a test can read it. Nothing in here is a
 * cookie value, a token, or a refresh token — only counts, states and the bot's
 * own email address. A terminal log is the easiest place in the world to leak a
 * credential from: it lands in scrollback, in CI output, in the screenshot
 * someone posts while debugging.
 */
export function formatSummonLog(input: {
  teamId: string;
  teamName: string;
  meetLink: string;
  callerEmail: string;
  via: string;
  context: ContextSummary;
  creds: CredentialSummary;
}): string {
  const { teamId, teamName, meetLink, callerEmail, via, context, creds } = input;
  const line = "─".repeat(66);

  return [
    "",
    `┌${line}┐`,
    `  ASTRA · BOT SUMMON`,
    `  ${new Date().toISOString()}   ·   auth via ${via}   ·   ${callerEmail}`,
    `├${line}┤`,
    `  1. TEAM ID        ${teamId}`,
    `                    "${teamName}"`,
    "",
    `  2. MEET LINK      ${meetLink}`,
    "",
    `  3. PRE-CONTEXT    ${context.present ? `received (${context.format ?? "json"})` : "MISSING"}`,
    ...(context.present && context.format === "markdown"
      ? [
          `                    team ......... ${context.team}`,
          `                    sections ..... ${(context.sections ?? []).join(", ") || "none"}`,
          `                    tables ....... ${context.table_rows ?? 0} row(s)`,
          `                    size ......... ${context.bytes} bytes, ~${context.tokens} tokens`,
        ]
      : context.present
      ? [
          `                    team ......... ${context.team}`,
          `                    roster ....... ${context.members} member(s)`,
          `                    github ....... ${context.open_prs} open PR(s), ${context.commits} commit(s)`,
          `                    jira ......... sprint "${context.sprint}", ${context.issues} issue(s)`,
          `                    analysis ..... verdict=${context.verdict}, ${context.risks} risk(s), ${context.talking_points} talking point(s)`,
          `                    size ......... ${context.bytes} bytes, ~${context.tokens} tokens`,
        ]
      : ["                    nothing supplied — the bot would join uninformed"]),
    "",
    `  4. BOT CREDS      ${creds.state.toUpperCase()}`,
    ...(creds.present
      ? [
          `                    account ...... ${creds.account}`,
          `                    cookies ...... ${creds.auth_cookies} auth of ${creds.google_cookies} Google (${creds.cookies_total} total)`,
          `                    origins ...... ${creds.origins}`,
          `                    ${creds.detail}`,
        ]
      : [`                    ${creds.detail}`]),
    `└${line}┘`,
    "",
  ].join("\n");
}
