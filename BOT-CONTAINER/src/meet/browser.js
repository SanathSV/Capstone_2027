import { chromium } from "playwright";
import { config } from "../config.js";

/**
 * Launching a browser that Google will let into a meeting.
 *
 * Two separate problems are solved here and they are worth keeping apart:
 *
 *  1. **Media.** Meet asks for the microphone and camera before it will let you
 *     into the green room. A container has neither, and the native permission
 *     bubble is drawn by Chrome rather than the page, so Playwright cannot
 *     click it. `--use-fake-ui-for-media-stream` auto-accepts the prompt and
 *     `--use-fake-device-for-media-stream` supplies a silent track to accept,
 *     so the join flow completes on a machine with no hardware at all.
 *
 *  2. **Detection.** Playwright's default flags advertise automation. Meet does
 *     not currently block on it, but Google's sign-in flow does, and the cost of
 *     the mitigations is a few command-line arguments.
 */

export const CHROMIUM_ARGS = [
  // The single most important one: stops Chromium advertising itself through
  // the Blink automation feature flag.
  "--disable-blink-features=AutomationControlled",
  // Auto-accept getUserMedia rather than showing the native bubble.
  "--use-fake-ui-for-media-stream",
  // Feed a silent audio / blank video track so there is something to accept.
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-notifications",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-popup-blocking",
  // Containers have no shared memory to speak of; Chrome crashes without this.
  "--disable-dev-shm-usage",
  "--no-sandbox",
  // A small window makes Meet collapse its toolbar and hide the captions
  // control in an overflow menu, which is a very confusing way to fail.
  "--window-size=1920,1080",
  "--window-position=0,0",
];

/** Flags Playwright adds by default that give the automation away. */
const IGNORED_DEFAULT_ARGS = ["--enable-automation"];

const STEALTH_JS = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
`;

/**
 * Open a browser context for one meeting.
 *
 * The credentials decide how:
 *
 *   storage_state — cookies exported by Astra's bot-auth flow. Playwright reads
 *                   them already decrypted over CDP, which is what makes them
 *                   portable; a Chrome *profile* directory is not, because its
 *                   cookies are encrypted under a key Windows wraps with DPAPI
 *                   and Linux Chrome in the container cannot unwrap.
 *
 *   password      — a scripted Google sign-in, attempted on request. See
 *                   `signInWithPassword` for why this is the weaker path.
 *
 *   guest         — no credentials. The bot asks to be let in by name and needs
 *                   a human to admit it.
 */
export async function launchContext({ credentials, log }) {
  const browser = await chromium.launch({
    headless: config.headless,
    args: CHROMIUM_ARGS,
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
  });

  const options = {
    viewport: { width: 1920, height: 1080 },
    permissions: ["microphone", "camera"],
    locale: "en-US",
    timezoneId: process.env.TZ || "UTC",
    // See config.userAgent: headless Chromium otherwise announces itself in
    // every request it makes.
    userAgent: config.userAgent,
  };

  if (credentials.mode === "storage_state") {
    const cookies = credentials.storageState.cookies ?? [];
    const google = cookies.filter((c) => String(c.domain ?? "").includes("google"));
    log.info(`using an exported Google session (${google.length} google cookie(s))`);
    options.storageState = sanitiseStorageState(credentials.storageState);
  }

  const context = await browser.newContext(options);
  await context.addInitScript(STEALTH_JS);
  context.setDefaultTimeout(30_000);

  return { browser, context };
}

/**
 * Playwright rejects a whole storage state over one malformed cookie, and a
 * state round-tripped through JSON in a browser extension picks up float
 * expiries and unexpected `sameSite` spellings. Repairing them here is the
 * difference between "the bot joined" and a stack trace before the browser even
 * opens.
 */
function sanitiseStorageState(state) {
  const SAME_SITE = new Set(["Strict", "Lax", "None"]);
  const cookies = (state.cookies ?? [])
    .filter((c) => c && c.name && c.domain)
    .map((c) => {
      const clean = {
        name: String(c.name),
        value: String(c.value ?? ""),
        domain: String(c.domain),
        path: String(c.path || "/"),
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: SAME_SITE.has(c.sameSite) ? c.sameSite : "Lax",
      };
      const expires = Number(c.expires);
      // -1 is Playwright's "session cookie"; anything else must be an integer.
      clean.expires = Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : -1;
      return clean;
    });

  return { cookies, origins: Array.isArray(state.origins) ? state.origins : [] };
}

/**
 * Scripted Google sign-in with an email and password.
 *
 * ⚠ Read this before relying on it.
 *
 * Google actively resists automated password sign-in. A headless Chromium
 * driving accounts.google.com routinely hits "This browser or app may not be
 * secure", a device-verification challenge, or a 2FA prompt — none of which a
 * container can answer. It works most reliably on a dedicated account with 2FA
 * off and a prior successful sign-in from the same IP, and it can start failing
 * without any change on our side.
 *
 * The reliable path is the exported session (`storage_state`), which Astra's
 * dashboard produces from a real human sign-in. This function exists because
 * the spec asks for email/password support, and it reports precisely what went
 * wrong rather than pretending — but treat a success here as a bonus.
 */
export async function signInWithPassword(page, { email, password }, log) {
  log.info(`signing in to Google as ${email} (scripted password login)`);
  await page.goto("https://accounts.google.com/ServiceLogin?hl=en", {
    waitUntil: "domcontentloaded",
  });

  try {
    await page.fill('input[type="email"], input#identifierId', email, { timeout: 15_000 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3_000);

    await page.fill('input[type="password"], input[name="Passwd"]', password, {
      timeout: 20_000,
    });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(6_000);
  } catch (error) {
    throw new Error(
      `Google's sign-in form did not accept scripted input (${error.message}). ` +
        "This is the expected failure mode for password login — use Astra → " +
        "Settings → Bot Account Setup to export a session instead.",
    );
  }

  const body = (await page.textContent("body").catch(() => "")) ?? "";
  const blocked = /couldn't sign you in|may not be secure|verify it's you|2-step|try again later/i;
  if (blocked.test(body)) {
    const quoted = (body.match(/[^.\n]{0,120}(may not be secure|verify it's you|2-step)[^.\n]{0,80}/i) || [])[0];
    throw new Error(
      `Google refused the scripted sign-in${quoted ? `: "${quoted.trim()}"` : ""}. ` +
        "Export a session from Astra → Settings → Bot Account Setup instead; " +
        "that path uses a real human sign-in and does not hit this check.",
    );
  }

  const cookies = await page.context().cookies("https://accounts.google.com");
  const names = new Set(cookies.map((c) => c.name));
  const signedIn = ["SID", "__Secure-1PSID", "__Secure-3PSID"].some((n) => names.has(n));
  if (!signedIn) {
    throw new Error(
      "The sign-in flow finished without a Google session cookie. The bot would " +
        "join as an anonymous guest.",
    );
  }

  log.info("Google sign-in succeeded");
  return true;
}
