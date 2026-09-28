import path from "node:path";
import { mkdir } from "node:fs/promises";
import { config } from "../config.js";

/**
 * Getting into a Google Meet call and turning captions on.
 *
 * Every selector here is an *accessible name* rather than a class, because Meet
 * rotates its obfuscated class names without notice while the ARIA labels are
 * part of its accessibility contract and change far more slowly. Where a label
 * is ambiguous the code says so and disambiguates — see `findCaptionButton`.
 */

const LEAVE_BUTTON = 'button[aria-label*="Leave call" i], button[aria-label*="Hang up" i]';
const MIC_BUTTON =
  'button[aria-label*="microphone" i], div[role="button"][aria-label*="microphone" i]';
const CAM_BUTTON = 'button[aria-label*="camera" i], div[role="button"][aria-label*="camera" i]';

const JOIN_BUTTON = /^\s*(join now|ask to join|join anyway|switch here)\s*$/i;

/**
 * Only an explicit on/off label identifies the real CC toggle. A bare
 * `[aria-label*="caption"]` also matches "Captions settings" and the language
 * picker, and clicking either of those does nothing at all — which presents as
 * a bot that joined and then transcribed silence.
 */
const CAPTION_TOGGLE_LABEL = /\bturn\s+(on|off)\b.*\b(captions?|subtitles?)\b/i;

/**
 * Every wording Meet uses for "you are waiting to be let in". The lobby screen
 * has a hang-up button of its own, so testing for the leave button first would
 * report "in the call" while still outside it — and then every in-call action
 * fails against a toolbar that does not exist yet.
 */
const LOBBY =
  /asking to be let in|waiting for the host|someone will let you in|please wait until a meeting host|you'll join the call when|waiting for someone to let you in|you can join when someone lets you in/i;

const REFUSAL =
  /you can't join|can't join this|denied your request|meeting hasn't started|call ended|not allowed to join|no one responded|check your meeting code|return to home screen/i;

const ALONE = /you're the only one here|you are the only one here|no one else is here/i;

const DISMISS_LABELS = [
  "Got it",
  "Dismiss",
  "Continue without microphone and camera",
  "Continue without microphone",
  "Continue without camera",
  "Use without a microphone",
  "No thanks",
  "Close",
  "OK",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clickFirstVisible(page, selector, timeout = 2000) {
  try {
    const target = page.locator(selector).first();
    await target.waitFor({ state: "visible", timeout });
    await target.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function bodyText(page, limit = 4000) {
  try {
    return (await page.innerText("body")).slice(0, limit);
  } catch {
    return "";
  }
}

export async function saveDebugShot(page, name, log) {
  if (!config.debugShots) return;
  try {
    const dir = path.join(config.dataDir, "debug");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await page.screenshot({ path: file });
    log?.warn(`saved a screenshot: ${file}`);
  } catch {
    // A failed screenshot is never worth failing the meeting over.
  }
}

async function dismissOverlays(page, log) {
  for (const label of DISMISS_LABELS) {
    try {
      const button = page.getByRole("button", {
        name: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"),
      });
      if (await button.count()) {
        await button.first().click({ timeout: 1500 });
        log?.debug(`dismissed overlay: ${label}`);
        await sleep(300);
      }
    } catch {
      // Overlays race with the page; a miss is fine.
    }
  }
}

/** Meet fades its control bar out; move the pointer so it renders again. */
async function wakeToolbar(page) {
  try {
    const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    await page.mouse.move(w / 2, h - 40);
    await sleep(400);
  } catch {
    /* the page is mid-navigation */
  }
}

async function deviceIsMuted(page, selector) {
  try {
    const button = page.locator(selector).first();
    if (!(await button.count())) return null;
    const attr = await button.getAttribute("data-is-muted");
    if (attr !== null) return attr === "true";
    const label = (await button.getAttribute("aria-label")) ?? "";
    if (/turn on/i.test(label)) return true;
    if (/turn off/i.test(label)) return false;
  } catch {
    return null;
  }
  return null;
}

/**
 * Mute microphone and camera before joining.
 *
 * Keyboard first (Ctrl+D / Ctrl+E) because it works whether or not the toolbar
 * is currently rendered, then a click as the fallback. Verified after each
 * attempt rather than assumed — a bot that joins with its camera on is a bot
 * nobody invites twice.
 */
export async function muteDevices(page, log) {
  for (const [shortcut, selector, name] of [
    ["Control+d", MIC_BUTTON, "microphone"],
    ["Control+e", CAM_BUTTON, "camera"],
  ]) {
    if ((await deviceIsMuted(page, selector)) === true) {
      log.debug(`${name} already off`);
      continue;
    }
    try {
      await page.keyboard.press(shortcut);
    } catch {
      /* no focus yet */
    }
    await sleep(600);
    if ((await deviceIsMuted(page, selector)) === false) {
      await clickFirstVisible(page, selector, 2500);
      await sleep(400);
    }
    const state = await deviceIsMuted(page, selector);
    log.info(`${name} off: ${state === null ? "unknown" : state}`);
  }
}

/** Click "Join now" / "Ask to join". Resolves true once a click lands. */
export async function clickJoin(page, log, timeoutMs = config.joinTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const button = page.getByRole("button", { name: JOIN_BUTTON });
      if (await button.count()) {
        const label = (await button.first().innerText()).trim();
        await button.first().click({ timeout: 5000 });
        log.info(`clicked "${label}"`);
        return true;
      }
    } catch {
      /* re-render mid-click */
    }
    for (const text of ["Join now", "Ask to join", "Join anyway"]) {
      if (await clickFirstVisible(page, `//span[normalize-space()="${text}"]/ancestor::button[1]`, 1200)) {
        log.info(`clicked "${text}" (text fallback)`);
        return true;
      }
    }
    await dismissOverlays(page, log);
    await sleep(1000);
  }
  return false;
}

/** Wait for the real in-call UI, tolerating an arbitrarily long stay in the lobby. */
export async function waitUntilInCall(page, log, timeoutMs = config.admitTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  while (Date.now() < deadline) {
    const body = await bodyText(page);

    if (LOBBY.test(body)) {
      if (!announced) {
        log.info("in the lobby — waiting for a host to admit the bot");
        announced = true;
      }
      await sleep(1500);
      continue;
    }

    // Quote Meet's own wording back: "refused" on its own gives no clue whether
    // the meeting is over, the code is wrong, or guests are simply not allowed.
    const refusal = body.match(new RegExp(`[^.\\n]*(${REFUSAL.source})[^.\\n]*`, "i"));
    if (refusal) {
      log.error(`Meet refused the join: "${refusal[0].trim().slice(0, 180)}"`);
      await saveDebugShot(page, `refused-${Date.now()}`, log);
      return { ok: false, reason: refusal[0].trim().slice(0, 200) };
    }

    try {
      if (await page.locator(LEAVE_BUTTON).count()) return { ok: true };
    } catch {
      /* transient */
    }
    await sleep(1500);
  }

  await saveDebugShot(page, `lobby-timeout-${Date.now()}`, log);
  return { ok: false, reason: "nobody admitted the bot before the wait ran out" };
}

async function findCaptionButton(page) {
  let handles = [];
  try {
    handles = await page.$$(
      'button[aria-label], div[role="button"][aria-label], span[role="button"][aria-label]',
    );
  } catch {
    return { handle: null, label: "" };
  }
  for (const handle of handles) {
    const label = (await handle.getAttribute("aria-label").catch(() => "")) ?? "";
    if (CAPTION_TOGGLE_LABEL.test(label)) return { handle, label };
  }
  return { handle: null, label: "" };
}

async function captionsAreOn(page) {
  const { label } = await findCaptionButton(page);
  if (!label) return null;
  if (/turn off/i.test(label)) return true;
  if (/turn on/i.test(label)) return false;
  return null;
}

/** Some builds pop a language or confirmation dialog after enabling captions. */
async function confirmCaptionDialog(page) {
  for (const name of ["Turn on", "Apply", "Done", "Got it"]) {
    try {
      const button = page.getByRole("button", { name: new RegExp(`^\\s*${name}\\s*$`, "i") });
      if (await button.count()) {
        await button.first().click({ timeout: 1500 });
        await sleep(400);
      }
    } catch {
      /* not present */
    }
  }
}

/**
 * Turn on live captions — the thing the whole container depends on.
 *
 * Four routes in order, each verified against the toggle's own label rather
 * than assumed to have worked:
 *   1. a JS click on the CC button (a JS click because Playwright refuses to
 *      click a node it considers invisible, and the toolbar fades out),
 *   2. Meet's real shortcut, which is a bare `c`,
 *   3. Ctrl+Shift+C, kept only because it is widely and wrongly cited,
 *   4. the More-options overflow menu, where a narrow window parks CC.
 */
export async function enableCaptions(page, log) {
  await wakeToolbar(page);

  if ((await captionsAreOn(page)) === true) {
    log.info("captions already on");
    return true;
  }

  const { handle, label } = await findCaptionButton(page);
  if (handle) {
    log.debug(`caption button: "${label}"`);
    for (let attempt = 0; attempt < 2; attempt++) {
      await handle.evaluate((el) => el.click()).catch(() => {});
      await sleep(1200);
      await confirmCaptionDialog(page);
      if ((await captionsAreOn(page)) === true) {
        log.info("captions enabled via the CC button");
        return true;
      }
      await wakeToolbar(page);
    }
  } else {
    // Without this, a renamed or genuinely missing CC control is
    // indistinguishable from a stale selector.
    const labels = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('button[aria-label], div[role="button"][aria-label]'))
          .map((e) => e.getAttribute("aria-label"))
          .filter(Boolean)
          .slice(0, 30),
      )
      .catch(() => []);
    log.warn(`no caption button found by accessible name; toolbar offers: ${JSON.stringify(labels)}`);
  }

  for (const shortcut of ["c", "Control+Shift+c"]) {
    await page.keyboard.press(shortcut).catch(() => {});
    await sleep(1200);
    await confirmCaptionDialog(page);
    if ((await captionsAreOn(page)) === true) {
      log.info(`captions enabled via the "${shortcut}" shortcut`);
      return true;
    }
  }

  try {
    await wakeToolbar(page);
    if (await clickFirstVisible(page, 'button[aria-label*="More options" i]', 3000)) {
      await sleep(800);
      const item = page.getByRole("menuitem", { name: /caption|subtitle/i });
      if (await item.count()) {
        await item.first().click({ timeout: 2500 });
        await sleep(1500);
        await confirmCaptionDialog(page);
      }
    }
  } catch {
    /* menu closed under us */
  }

  if ((await captionsAreOn(page)) === true) {
    log.info("captions enabled via the More-options menu");
    return true;
  }

  await saveDebugShot(page, `captions-${Date.now()}`, log);
  log.warn("could not confirm captions are on — scraping anyway");
  return false;
}

/**
 * Tell Meet which language people will be SPEAKING.
 *
 * Meet does not auto-detect an arbitrary language: captions transcribe the
 * language the account is configured for, so leaving it on English while the
 * standup happens in Telugu produces nonsense rather than Telugu text. The
 * scraper itself is language-agnostic — it copies whatever Meet renders.
 *
 * Best-effort by design. Meet only lists the languages it supports for the
 * host's account type, and a language that is not offered is a fact about the
 * meeting, not a failure worth aborting a join over.
 */
export async function setCaptionLanguage(page, language, log) {
  if (!language) return true;
  log.info(`setting the caption language to "${language}"`);
  await wakeToolbar(page);

  let opened = false;
  for (const selector of [
    'button[aria-label*="Captions settings" i]',
    'button[aria-label*="caption" i][aria-label*="setting" i]',
    'button[aria-label*="caption" i][aria-label*="language" i]',
  ]) {
    if (await clickFirstVisible(page, selector, 3000)) {
      opened = true;
      break;
    }
  }
  if (!opened && (await clickFirstVisible(page, 'button[aria-label*="More options" i]', 3000))) {
    await sleep(700);
    try {
      const item = page.getByRole("menuitem", { name: /caption|subtitle/i });
      if (await item.count()) {
        await item.first().click({ timeout: 2500 });
        opened = true;
      }
    } catch {
      /* menu closed under us */
    }
  }
  if (!opened) {
    log.warn("could not open captions settings; leaving the language as it is");
    return false;
  }

  await sleep(1200);
  const wanted = new RegExp(language.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  // The picker is a combobox whose options do not exist until it is opened.
  try {
    const combo = page.getByRole("combobox");
    if (await combo.count()) {
      await combo.first().click({ timeout: 3000 });
      await sleep(700);
    }
  } catch {
    /* not a combobox in this build */
  }

  for (const role of ["option", "menuitemradio", "menuitem"]) {
    try {
      const option = page.getByRole(role, { name: wanted });
      if (!(await option.count())) continue;
      await option.first().click({ timeout: 3000 });
      await sleep(700);
      for (const label of ["Apply", "Done", "Save"]) {
        const button = page.getByRole("button", { name: new RegExp(`^\\s*${label}\\s*$`, "i") });
        if (await button.count()) {
          await button.first().click({ timeout: 2000 });
          break;
        }
      }
      log.info(`caption language set to "${language}"`);
      return true;
    } catch {
      continue;
    }
  }

  log.warn(
    `"${language}" was not offered in the caption language list — Meet only lists ` +
      "languages it supports for the host's account type",
  );
  return false;
}

/**
 * Re-assert captions periodically.
 *
 * Enabling once at join is not enough: the CC control gets re-rendered, and a
 * host can turn captions off for everyone mid-call. Without this the bot goes
 * quietly deaf and nobody finds out until the transcript is empty.
 */
export function startCaptionWatchdog(page, log, { intervalMs = 15_000 } = {}) {
  const timer = setInterval(async () => {
    try {
      if (page.isClosed()) return;
      if ((await captionsAreOn(page)) === false) {
        log.warn("captions were switched off — turning them back on");
        await enableCaptions(page, log);
      }
    } catch {
      /* page busy */
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

const PARTICIPANT_COUNT_JS = `() => {
  const sels = [
    'button[aria-label*="participant" i]',
    'button[aria-label*="Show everyone" i]',
    'button[aria-label*="People" i]',
  ];
  for (const sel of sels) {
    const btn = document.querySelector(sel);
    if (!btn) continue;
    const label = btn.getAttribute('aria-label') || '';
    const m = label.match(/(\\d+)/);
    if (m) return parseInt(m[1], 10);
    const badge = (btn.innerText || '').match(/(\\d+)/);
    if (badge) return parseInt(badge[1], 10);
  }
  const ids = new Set(
    Array.from(document.querySelectorAll('[data-participant-id]'))
      .map((el) => el.getAttribute('data-participant-id'))
      .filter(Boolean)
  );
  return ids.size || null;
}`;

/**
 * True when the bot is the only one left. `null` means unknown — deliberately
 * distinct from `false`, because an unreadable page must never be mistaken for
 * an empty room and hang up on a live call.
 */
export async function isAlone(page) {
  try {
    const body = await bodyText(page, 3000);
    if (ALONE.test(body)) return true;
    const count = await page.evaluate(PARTICIPANT_COUNT_JS);
    if (count === null || count === undefined) return null;
    return count <= 1;
  } catch {
    return null;
  }
}

export async function callIsAlive(page) {
  try {
    if (page.isClosed()) return false;
    const body = await bodyText(page, 3000);
    if (LOBBY.test(body)) return true; // pushed back to the lobby, still connected
    if (await page.locator(LEAVE_BUTTON).count()) return true;
    return !/you(?:'ve| have) left|call ended|return to home screen/i.test(body);
  } catch {
    return false;
  }
}

export async function leaveCall(page, log) {
  try {
    if (page.isClosed()) return;
    if (await clickFirstVisible(page, LEAVE_BUTTON, 3000)) {
      log.info("left the call");
      await sleep(1000);
    }
  } catch {
    // Leaving can itself tear down the browser; that is a successful leave.
  }
}

/** The Google account the browser is actually using, so the log can prove it. */
export async function signedInAccount(page) {
  try {
    const body = await bodyText(page);
    const joining = body.match(/joining as\s*([\w.+-]+@[\w.-]+)/i);
    if (joining) return joining[1];
    for (const selector of [
      'a[aria-label*="Google Account" i]',
      'button[aria-label*="Google Account" i]',
      '[aria-label*="@" i]',
    ]) {
      const el = page.locator(selector).first();
      if (await el.count()) {
        const label = (await el.getAttribute("aria-label")) ?? "";
        const email = label.match(/[\w.+-]+@[\w.-]+\.\w+/);
        if (email) return email[0];
      }
    }
  } catch {
    /* not on a page that says */
  }
  return null;
}

/** A signed-out profile is offered a "Your name" box on the green room screen. */
export async function fillGuestName(page, name, log) {
  const box = page
    .locator('input[aria-label*="your name" i], input[placeholder*="your name" i]')
    .first();
  try {
    if (await box.count()) {
      await box.fill(name, { timeout: 3000 });
      log.info(`joining as a guest named "${name}"`);
      return true;
    }
  } catch {
    /* signed in, so there is no box */
  }
  return false;
}

export { dismissOverlays, wakeToolbar, clickFirstVisible, LEAVE_BUTTON };
