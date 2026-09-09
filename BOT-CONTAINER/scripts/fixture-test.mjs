/**
 * Run the caption observer against Meeting_Bot's Meet replica.
 *
 *     node scripts/fixture-test.mjs
 *
 * `Meeting_Bot/tests/fake_meet.html` reproduces Meet's caption DOM — the
 * `jsname="dsyhDe"` region, `jsname="tgaKEf"` text nodes wrapped in a span,
 * `.zs7s8d` speaker names, avatar `img[alt]` — and, crucially, its *behaviour*:
 * a block that grows in place while somebody talks, then a new sibling block
 * when the next person starts. It also hides its toolbar behind
 * `visibility: hidden`, reproducing Meet's auto-hiding controls.
 *
 * That Python scraper produced real transcripts with real speaker names, so this
 * is a known-good reference rather than another guess. If the container cannot
 * read it, the bug is in the container; if it can, the bug is in the meeting —
 * and in practice that means captions were never switched on.
 *
 * The fixture is read from the sibling directory rather than copied, so it
 * cannot drift out of step with the thing it mirrors. Skips cleanly when
 * Meeting_Bot is not present.
 */
import { chromium } from "playwright";
import path from "node:path";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CAPTION_OBSERVER_JS } from "../src/meet/captions.js";
import { clickJoin, enableCaptions, muteDevices } from "../src/meet/join.js";
import { logger } from "../src/log.js";

const FIXTURE = path.resolve("../Meeting_Bot/tests/fake_meet.html");

try {
  await access(FIXTURE);
} catch {
  console.log(`\nSkipping: ${FIXTURE} not found (Meeting_Bot is not checked out here).\n`);
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\nfixture: ${FIXTURE}\n`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const messages = [];
await context.exposeBinding("__astraCaption", (_s, payload) => messages.push(JSON.parse(payload)));
const page = await context.newPage();
page.on("pageerror", (e) => { fail++; console.log("  PAGE ERROR:", e.message); });

await page.goto(pathToFileURL(FIXTURE).href);

// Install the observer BEFORE joining, exactly as session.js does — so a
// caption cannot appear before something is watching for it.
await page.evaluate(CAPTION_OBSERVER_JS);

// The container's OWN join code, not raw clicks. The fixture hides its toolbar
// on purpose, which is what makes a plain Playwright click time out, so driving
// the real functions tests muteDevices() and enableCaptions() as well rather
// than reaching the captions by a shortcut no meeting would allow.
const log = logger("[fixture]");
await muteDevices(page, log);
check("the Join button is found and clicked", await clickJoin(page, log, 10_000));
check("captions are switched on through the hidden toolbar", await enableCaptions(page, log));

const diag = await page.evaluate(() => window.__astraCapDiag());
console.log(`  root: ${diag.rootTag} jsname=${diag.rootJsname} · matched ${diag.rootSelectorsMatched.join(", ")}`);
check("the caption region is found", diag.rootFound);
check("and it is the inner scroller, not an outer region", diag.rootJsname === "dsyhDe", diag.rootJsname);

// NOTE: the caption script is started by the CC click itself, inside
// enableCaptions() above. Calling runCaptionScript() again here would play it
// twice and overlap two Alices — which produces a transcript full of duplicated
// partial sentences and looks exactly like an observer bug. It is not one.
const finals = () => messages.filter((m) => m.type === "final");
const deltas = () => messages.filter((m) => m.type === "delta");

/**
 * Wait on a condition, not a clock. The script runs on Meet-like timings and
 * enableCaptions takes a variable time to get through the hidden toolbar, so
 * fixed sleeps make this flaky for reasons that say nothing about the observer.
 */
async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  console.log(`  (timed out waiting for ${label})`);
  return false;
}

// ---- Alice's block grows in place: "So I" -> ... -> "...on Friday" --------
await waitFor(
  "Alice's sentence to finish growing",
  () => deltas().some((d) => d.text === "So I think we should ship it on Friday"),
);

check("interim growth is reported as deltas", deltas().length >= 3, `${deltas().length}`);
check(
  "a sentence still growing is NOT finalised",
  finals().length === 0,
  JSON.stringify(finals().map((m) => m.text)),
);
check(
  "growth is attributed to the speaker of that block",
  deltas().every((d) => d.speaker === "Alice Chen"),
  JSON.stringify([...new Set(deltas().map((d) => d.speaker))]),
);

// ---- Bob starting a new block is what freezes Alice's: the delta rule -----
await waitFor("Bob's block to supersede Alice's", () => finals().length >= 1);

check("a new speaker's block finalises the previous one", finals().length === 1, JSON.stringify(finals().map((m) => m.text)));
check(
  "the finalised text is the COMPLETE sentence, not a partial",
  finals()[0]?.text === "So I think we should ship it on Friday",
  finals()[0]?.text,
);
check("attributed to the right person", finals()[0]?.speaker === "Alice Chen", finals()[0]?.speaker);
check("finalised because it was superseded", finals()[0]?.reason === "superseded", finals()[0]?.reason);
check(
  "and emitted once, not once per growth step",
  finals().filter((m) => m.text === finals()[0]?.text).length === 1,
);

// ---- leaving flushes whatever is still on screen --------------------------
await waitFor("Bob's sentence to finish", () => deltas().some((d) => d.text === "Agreed, let's do it"));
await page.evaluate(() => window.__astraFlush());
await sleep(300);

const all = finals();
check("the trailing block is flushed on leave", all.length === 2, JSON.stringify(all.map((m) => m.text)));
check("with the second speaker's complete text", all[1]?.text === "Agreed, let's do it", all[1]?.text);
check("attributed to Bob", all[1]?.speaker === "Bob Ortiz", all[1]?.speaker);
check(
  "no interface text was transcribed",
  !all.some((m) => /jump to bottom|turn on captions|settings|language/i.test(m.text)),
  JSON.stringify(all.map((m) => m.text)),
);
check(
  "no speaker name was transcribed as speech",
  !all.some((m) => /^(Alice Chen|Bob Ortiz)$/.test(m.text)),
  JSON.stringify(all.map((m) => m.text)),
);
check(
  "and no line is a prefix of another — the duplicated-partial bug",
  !all.some((a, i) => all.some((b, j) => i !== j && b.text.startsWith(a.text))),
  JSON.stringify(all.map((m) => m.text)),
);

console.log("\n  transcript as the container would record it:");
for (const m of all) console.log(`    ${m.speaker} » ${m.text}`);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
