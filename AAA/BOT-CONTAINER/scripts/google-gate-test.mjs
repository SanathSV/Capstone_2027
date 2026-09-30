/**
 * Tests the Google gate detector against the real accounts.google.com, using
 * whatever session Astra has exported on this machine.
 *
 *     node scripts/google-gate-test.mjs
 *
 * This is not a mock. The whole value of the module is that it correctly reads
 * a page Google renders and versions on its own schedule, so testing it against
 * a fixture would test the fixture. It makes one navigation to a page that
 * belongs to the bot's own account and touches no meeting.
 *
 * It asserts the *shape* of the answer rather than a particular verdict —
 * "REJECTED, and the reason names re-authentication" is a pass, and so is
 * "ACCEPTED". A test that demanded one of the two would start failing the day
 * somebody re-authenticated.
 */
import { chromium } from "playwright";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { GATE, inspectGoogleGate, passGoogleGate } from "../src/meet/google.js";
import { logger } from "../src/log.js";

const SECRETS = path.resolve("../astra-platform/bot-auth/secrets/leaders");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function findSession() {
  let dirs = [];
  try {
    dirs = await readdir(SECRETS);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(SECRETS, dir, "auth.json");
    try {
      const state = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(state.cookies) && state.cookies.length) return { file, state };
    } catch {
      /* not this one */
    }
  }
  return null;
}

const found = await findSession();
if (!found) {
  console.log("\nNo exported bot session on this machine — nothing to test against.");
  console.log("Authenticate one at Astra → Settings → Bot Account Setup first.\n");
  process.exit(0);
}
console.log(`\nUsing ${found.file}`);

const log = logger("[gate-test]");
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  ignoreDefaultArgs: ["--enable-automation"],
});
const context = await browser.newContext({
  storageState: { cookies: found.state.cookies, origins: found.state.origins ?? [] },
  viewport: { width: 1920, height: 1080 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});
const page = await context.newPage();

console.log("\nA. a page that is not a Google gate at all");
await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
const none = await inspectGoogleGate(page);
check("reports no gate on an ordinary page", none.kind === GATE.NONE, none.kind);

console.log("\nB. the real accounts.google.com");
await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
await new Promise((r) => setTimeout(r, 3000));

const gate = await inspectGoogleGate(page);
console.log(`     detected: ${gate.kind}`);
console.log(`     accounts: ${gate.detail || "(none)"}`);

check(
  "returns a known gate kind",
  Object.values(GATE).includes(gate.kind),
  gate.kind,
);

const result = await passGoogleGate(page, { log, attempts: 1 });
console.log(`     verdict : ${result.ok ? "ACCEPTED" : "REJECTED"}`);
if (!result.ok) console.log(`     reason  : ${result.reason}`);

if (gate.kind === GATE.NONE) {
  check("a live session passes the gate", result.ok === true);
  console.log("\n  (the exported session is currently VALID)");
} else if (gate.kind === GATE.CHOOSER_SIGNED_OUT) {
  check("a dead session is refused rather than waited on", result.ok === false);
  check("the account is identified by email", /\S+@\S+/.test(gate.detail), gate.detail);
  check("every listed account is marked signed out", (gate.accounts ?? []).every((a) => a.signedOut));
  check(
    "the reason tells the user to re-authenticate",
    /Bot Account Setup/i.test(result.reason ?? ""),
  );
  check(
    "the reason does not blame the meeting link",
    !/meeting has not started|link may be wrong/i.test(result.reason ?? ""),
  );
  console.log("\n  (the exported session is DEAD — this is the case the bot was stuck on)");
} else {
  check("a non-NONE gate produces an actionable reason", Boolean(result.reason), result.reason ?? "");
  console.log(`\n  (gate was ${gate.kind})`);
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
