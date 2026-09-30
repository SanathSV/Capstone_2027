/**
 * The Google sign-in gate that stands between the bot and the meeting.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * Navigating to a Meet link with a dead session does not produce an error. It
 * produces a *different page* — accounts.google.com — which looks nothing like
 * Meet and contains no Join button. Without this module the bot spends its
 * whole join timeout hunting for a button on a sign-in screen and then reports
 * "Never found a Join button. The link may be wrong, or the meeting has not
 * started." Every word of which is wrong, and which sends whoever reads it off
 * to check a meeting link that was fine all along.
 *
 * So: identify the gate, name it precisely, get through it when that is
 * possible, and fail immediately and accurately when it is not.
 *
 * ===========================================================================
 * WHY AN EXPORTED SESSION GOES DEAD
 * ===========================================================================
 * The credential Astra exports is a cookie jar, and two of those cookies —
 * `__Secure-1PSIDTS` and `__Secure-3PSIDTS` — are **rotation tokens**. Google
 * reissues them continuously as the account is used, and presenting a stale one
 * from a second browser is exactly the pattern session hijacking has, so Google
 * resolves it the safe way: it invalidates the session.
 *
 * The practical consequence is that a bot session goes stale on its own, with
 * no expiry to check and nothing wrong with the file. The cookies are all
 * present, none has expired, and Google refuses them anyway — the account
 * chooser lists the account with "Signed out" beside it. The only fix is to
 * authenticate again; nothing this container does can revive it.
 *
 * That is worth stating in the error, because "re-authenticate" is not the
 * conclusion anyone draws from a screen that lists their account by name.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What is standing in the way. */
export const GATE = {
  /** Not on a Google auth page at all — carry on. */
  NONE: "none",
  /** The chooser, with our account listed as still signed in. Clickable. */
  CHOOSER_LIVE: "chooser_live",
  /** The chooser, with our account listed as "Signed out". Fatal. */
  CHOOSER_SIGNED_OUT: "chooser_signed_out",
  /** An email/password form. Fatal without password credentials. */
  SIGNIN: "signin",
  /** "Verify it's you", 2FA, "this browser may not be secure". Fatal. */
  CHALLENGE: "challenge",
  /** On accounts.google.com but none of the above matched. */
  UNKNOWN: "unknown",
};

const CHALLENGE_TEXT =
  /verify it'?s you|2-step|two-step|couldn'?t sign you in|this browser or app may not be secure|unusual activity|confirm your recovery/i;

/**
 * Look at the page and decide what, if anything, is blocking the join.
 *
 * Reads the rendered text rather than trusting the URL alone: Meet bounces
 * through several accounts.google.com paths that are transient, and a URL check
 * on its own reports a gate that has already cleared itself.
 */
export async function inspectGoogleGate(page) {
  let url = "";
  try {
    url = page.url();
  } catch {
    return { kind: GATE.NONE, url: "", detail: "" };
  }

  const onAuthHost = /accounts\.google\.com|consent\.google\.com/i.test(url);
  let body = "";
  try {
    body = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ").slice(0, 3000);
  } catch {
    body = "";
  }

  if (!onAuthHost && !/Choose an account/i.test(body)) {
    return { kind: GATE.NONE, url, detail: "" };
  }

  if (CHALLENGE_TEXT.test(body)) {
    const quoted = body.match(
      /[^.]{0,80}(verify it'?s you|couldn'?t sign you in|may not be secure|2-step)[^.]{0,80}/i,
    );
    return { kind: GATE.CHALLENGE, url, detail: (quoted?.[0] ?? "").trim() };
  }

  if (/Choose an account/i.test(body)) {
    // Read the tiles rather than the whole page: "Signed out" has to be
    // attributed to a specific account, not merely present somewhere on screen.
    const accounts = await listChooserAccounts(page);
    const anyLive = accounts.some((a) => !a.signedOut);
    return {
      kind: anyLive ? GATE.CHOOSER_LIVE : GATE.CHOOSER_SIGNED_OUT,
      url,
      accounts,
      detail: accounts.map((a) => `${a.email}${a.signedOut ? " (signed out)" : ""}`).join(", "),
    };
  }

  if (/Sign in|Enter your email|Forgot email/i.test(body)) {
    return { kind: GATE.SIGNIN, url, detail: "" };
  }

  return { kind: GATE.UNKNOWN, url, detail: body.slice(0, 160) };
}

/**
 * The accounts offered by the chooser, and whether each still has a session.
 *
 * ---------------------------------------------------------------------------
 * THE ATTRIBUTION PROBLEM
 * ---------------------------------------------------------------------------
 * "Signed out" is the whole answer, and it is **not** in the same element as
 * the email. Google renders the address in its own leaf node and the status as
 * a sibling further up:
 *
 *     <div>                                    <- the row: both, one email
 *       <div class="yAlK0b">bot@example.com</div>
 *       <div>Signed out</div>
 *     </div>
 *
 * So taking the innermost node carrying the email — the obvious thing, and what
 * this did first — reads "bot@example.com" with no status and reports a dead
 * session as a live one. The bot then clicks the account, lands on a password
 * form, and the failure is misdiagnosed all over again.
 *
 * Taking the *outermost* container is wrong in the other direction: with two
 * accounts listed it swallows both rows, and one signed-out account would mark
 * the other signed out too.
 *
 * The rule that is right in both cases: from the leaf holding the address, walk
 * up while the ancestor still contains **exactly one** email address, and use
 * the largest such ancestor. That is the row when there are several accounts,
 * and the whole list when there is only one — where the status can only belong
 * to that account anyway.
 *
 * Text, not class names: `yAlK0b` will be something else next month, but the
 * address and the words beside it are what screen readers read, so they have to
 * stay.
 */
async function listChooserAccounts(page) {
  try {
    return await page.evaluate(() => {
      const EMAIL = /[\w.+-]+@[\w.-]+\.\w+/g;
      const countEmails = (text) => (text.match(EMAIL) || []).length;
      const flat = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();

      // Leaves first: the smallest elements that carry an address at all.
      const leaves = [];
      for (const el of document.querySelectorAll("*")) {
        const text = flat(el);
        if (!text || text.length > 120 || countEmails(text) !== 1) continue;
        const childHasIt = [...el.children].some((c) => countEmails(flat(c)) === 1);
        if (!childHasIt) leaves.push(el);
      }

      const rows = new Map();
      for (const leaf of leaves) {
        const email = (flat(leaf).match(EMAIL) || [])[0];
        if (!email) continue;

        // Climb while the ancestor is still about this one account.
        let row = leaf;
        let node = leaf.parentElement;
        for (let hop = 0; hop < 8 && node && node !== document.body; hop++) {
          if (countEmails(flat(node)) !== 1) break;
          row = node;
          node = node.parentElement;
        }

        const text = flat(row);
        if (!rows.has(email) || text.length > rows.get(email).text.length) {
          rows.set(email, { email, text, signedOut: /signed out/i.test(text) });
        }
      }

      return [...rows.values()].map(({ email, signedOut }) => ({ email, signedOut }));
    });
  } catch {
    return [];
  }
}

/** Click the chooser tile for a live account. Returns true if a click landed. */
async function clickAccount(page, email, log) {
  const targets = [
    email ? `[data-identifier="${email}"]` : null,
    email ? `[data-email="${email}"]` : null,
  ].filter(Boolean);

  for (const selector of targets) {
    try {
      const node = page.locator(selector).first();
      if (await node.count()) {
        await node.click({ timeout: 5000 });
        log.info(`chose the account ${email} from the chooser`);
        return true;
      }
    } catch {
      /* try the next strategy */
    }
  }

  // Fall back to the visible text, which is what a person would click.
  try {
    const byText = page.getByText(email ?? /@/, { exact: false }).first();
    if (await byText.count()) {
      await byText.click({ timeout: 5000 });
      log.info(`chose an account from the chooser by its text`);
      return true;
    }
  } catch {
    /* nothing clickable */
  }
  return false;
}

/**
 * Get past the gate, or explain precisely why that is impossible.
 *
 * @returns {{ok: boolean, kind: string, recovered: boolean, reason: string|null}}
 *   `ok: true`  — nothing in the way, or we clicked through it.
 *   `ok: false` — `reason` is a sentence fit to show a human, naming the fix.
 */
export async function passGoogleGate(page, { email = null, log, attempts = 2 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const gate = await inspectGoogleGate(page);

    if (gate.kind === GATE.NONE) {
      return { ok: true, kind: GATE.NONE, recovered: attempt > 0, reason: null };
    }

    log.warn(`Google gate: ${gate.kind}${gate.detail ? ` — ${gate.detail}` : ""}`);

    if (gate.kind === GATE.CHOOSER_LIVE) {
      const live = (gate.accounts ?? []).find((a) => !a.signedOut);
      if (await clickAccount(page, email ?? live?.email, log)) {
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
        await sleep(2500);
        continue; // re-inspect: one click can lead to another screen
      }
      return {
        ok: false,
        kind: gate.kind,
        recovered: false,
        reason:
          "Google showed an account chooser and the bot could not click through it. " +
          `Accounts offered: ${gate.detail || "none readable"}.`,
      };
    }

    if (gate.kind === GATE.CHOOSER_SIGNED_OUT) {
      const named = (gate.accounts ?? []).map((a) => a.email).join(", ") || email || "the bot account";
      return {
        ok: false,
        kind: gate.kind,
        recovered: false,
        // The single most important error message in this container: it is the
        // one a person will actually hit, and the obvious reading of the screen
        // ("my account is right there") points away from the real fix.
        reason:
          `Google has invalidated the bot's saved session — its account chooser lists ` +
          `${named} as "Signed out". The cookies are all present and unexpired; Google ` +
          `rejected them anyway, which is what happens once the rotating ` +
          `__Secure-1PSIDTS token in an exported session goes stale. Nothing here can ` +
          `revive it. Fix: open Astra → Settings → Bot Account Setup and authenticate ` +
          `the bot account again, then summon the bot once more.`,
      };
    }

    if (gate.kind === GATE.CHALLENGE) {
      return {
        ok: false,
        kind: gate.kind,
        recovered: false,
        reason:
          `Google put a security challenge in front of the bot account` +
          `${gate.detail ? `: "${gate.detail}"` : ""}. A container cannot answer one — ` +
          `it needs a person at a browser. Re-authenticate at Astra → Settings → ` +
          `Bot Account Setup, completing any verification Google asks for there.`,
      };
    }

    if (gate.kind === GATE.SIGNIN) {
      return {
        ok: false,
        kind: gate.kind,
        recovered: false,
        reason:
          "Google asked the bot to sign in from scratch, so the saved session is no " +
          "longer valid. Re-authenticate at Astra → Settings → Bot Account Setup.",
      };
    }

    return {
      ok: false,
      kind: gate.kind,
      recovered: false,
      reason:
        `The bot landed on a Google page it did not recognise (${gate.url.slice(0, 120)}). ` +
        `It said: "${gate.detail}"`,
    };
  }

  return {
    ok: false,
    kind: GATE.UNKNOWN,
    recovered: false,
    reason: "Google kept redirecting the bot between sign-in screens.",
  };
}

/**
 * Check the session before opening the meeting.
 *
 * Three seconds spent here saves the whole join timeout spent failing for the
 * wrong reason later, and — more importantly — it means the error names the
 * credential rather than the meeting link. accounts.google.com is used as the
 * probe because it is cheap, it is signed-in-aware, and it does not touch the
 * meeting, so nobody in the room sees a bot appear and vanish.
 */
export async function verifySession(page, { email = null, log } = {}) {
  try {
    await page.goto("https://accounts.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch (error) {
    // A probe that cannot load is not proof the session is bad; let the real
    // join decide rather than blocking on a flaky network.
    log.warn(`could not pre-check the Google session: ${error.message}`);
    return { ok: true, skipped: true, reason: null };
  }
  await sleep(2500);

  const result = await passGoogleGate(page, { email, log, attempts: 2 });
  if (result.ok) log.info("the bot's Google session is live");
  return result;
}
