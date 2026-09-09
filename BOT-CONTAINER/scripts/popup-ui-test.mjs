/**
 * Drives the real popup.html / popup.js in Chromium, with the chrome.* APIs and
 * the network stubbed, so every live-status state can be exercised without a
 * meeting, a Google account or a running container.
 *
 * It exists for one specific requirement: **the popup must never offer to
 * summon a second bot into a room that already has one.** That is easy to get
 * right on the happy path and easy to get wrong on reopen, because a popup's
 * memory is destroyed every time it closes — so section D reloads the page and
 * checks the state is re-derived from the container rather than remembered.
 *
 *     node scripts/popup-ui-test.mjs
 */
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";

// path.resolve, not a literal: path.join produces backslashes on Windows, and
// comparing those against a forward-slash prefix rejects every request as an
// escape attempt.
const DIR = path.resolve("../astra-platform/chrome-extension");
const MEET = "https://meet.google.com/okf-dwkm-ydu";

/**
 * The popup is ES modules, and browsers refuse to load those over file://
 * (opaque origin, blocked by CORS). So the extension folder is served over http
 * for the length of the test. The popup itself is unmodified.
 */
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "popup.html";
  const file = path.join(DIR, rel);
  if (!file.startsWith(DIR)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/**
 * The fake container's state lives HERE, in Node, not in the page.
 *
 * That is the whole point of section D: a reload wipes anything the page was
 * holding, which is exactly what happens when a real popup closes and reopens.
 * State kept page-side would be reset by the reload and the test would "pass"
 * against a popup that had actually forgotten everything.
 */
const box = { live: null, stopCalls: 0, dispatchCalls: 0 };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
page.on("pageerror", (e) => {
  fail++;
  console.log("  PAGE ERROR:", e.message);
});

// Survives navigation, unlike anything stored on `window`.
await page.exposeFunction("__container", (op, arg) => {
  if (op === "get") return box.live;
  if (op === "stop") {
    box.stopCalls += 1;
    box.live = { ...box.live, status: "leaving" };
    return box.live;
  }
  if (op === "dispatch") {
    box.dispatchCalls += 1;
    box.live = {
      session_id: "s-new",
      status: "queued",
      meeting: { id: "m", number: 4 },
      team: { name: "Astra_dev" },
      counts: {},
      error: null,
      google_account: null,
    };
    return { status: "accepted", session_id: "s-new", meeting: { number: 4 }, team: { name: "Astra_dev" } };
  }
  return null;
});

await page.addInitScript(({ meet }) => {
  // --- chrome.* -----------------------------------------------------------
  // A real popup reads its session from chrome.storage.local, which survives
  // the popup closing; sessionStorage is the closest equivalent here.
  const KEY = "astra.session";
  const seed = JSON.stringify({
    access_token: "test-token",
    refresh_token: "test-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "u1", email: "kalpana@example.com" },
  });
  if (!sessionStorage.getItem(KEY)) sessionStorage.setItem(KEY, seed);

  window.chrome = {
    tabs: { query: async () => [{ url: meet }] },
    storage: {
      local: {
        get: async (k) => {
          const raw = sessionStorage.getItem(k);
          return { [k]: raw ? JSON.parse(raw) : undefined };
        },
        set: async (o) => {
          for (const [k, v] of Object.entries(o)) sessionStorage.setItem(k, JSON.stringify(v));
        },
        remove: async (k) => sessionStorage.removeItem(k),
      },
    },
  };

  // --- network ------------------------------------------------------------
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    const u = String(url);
    // The test's own static server serves the popup's real assets.
    if (u.startsWith(location.origin)) return realFetch(url, init);

    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (u.includes("/rest/v1/teams")) {
      return json([{ id: "t1", name: "Astra_dev", sprint_name: "Sprint 3" }]);
    }
    if (u.includes("/precontext")) {
      return json({
        payload: "# Astra_dev\nbriefing",
        token_estimate: 451,
        source: "cached",
        age_seconds: 30,
      });
    }
    if (u.includes("/api/bot-auth/session")) {
      return json({
        cookies: [{ domain: ".google.com", name: "SID" }],
        origins: [],
        google_email: "bot@pes.edu",
      });
    }
    if (u.includes("/api/start-bot")) {
      return json(await window.__container("dispatch"));
    }
    if (u.includes("/api/sessions") && u.includes("meet_link=")) {
      const live = await window.__container("get");
      return json({ status: "ok", sessions: live ? [live] : [] });
    }
    if (u.endsWith("/stop")) {
      return json({ status: "ok", session: await window.__container("stop") });
    }
    if (u.includes("/api/sessions/")) {
      return json({ status: "ok", session: await window.__container("get") });
    }
    return json({}, 404);
  };
}, { meet: MEET });

const url = `${ORIGIN}/popup.html`;
const visible = (id) => page.evaluate((i) => !document.getElementById(i).hidden, id);
const text = (id) => page.evaluate((i) => document.getElementById(i).textContent.trim(), id);
const cls = (id) => page.evaluate((i) => document.getElementById(i).className, id);
const setLive = (s) => {
  box.live = s;
};

// ===========================================================================
console.log("\nA. no bot in the room — the normal summon flow");
// ===========================================================================
await page.goto(url);
await page.waitForTimeout(900);

check("main pane is shown", await visible("mainPane"));
check("Connect Bot is visible", await visible("connect"));
check("Remove Bot is hidden", !(await visible("remove")));
check("live panel is hidden", !(await visible("live")));
check("button says Connect Bot", (await text("connect")) === "Connect Bot");
check("readiness checks are shown", await visible("readiness"));
check(
  "connect is enabled once prefetched",
  await page.evaluate(() => !document.getElementById("connect").disabled),
);

// ===========================================================================
console.log("\nB. clicking Connect hands straight over to the live panel");
// ===========================================================================
await page.click("#connect");
await page.waitForTimeout(500);

check("dispatch was called once", box.dispatchCalls === 1);
check("Connect Bot is now hidden", !(await visible("connect")));
check("Remove Bot appeared", await visible("remove"));
check("live panel appeared", await visible("live"));
check("readiness is hidden", !(await visible("readiness")));
check("team select is locked", await page.evaluate(() => document.getElementById("team").disabled));
check("status reads Starting", (await text("liveState")) === "Starting");
check("meeting number is shown", (await text("liveWhere")).includes("Meeting #4"));

// ===========================================================================
console.log("\nC. the panel tracks the join");
// ===========================================================================
setLive({
  session_id: "s-new",
  status: "waiting_admission",
  meeting: { number: 4 },
  team: { name: "Astra_dev" },
  counts: {},
  error: null,
});
await page.waitForTimeout(3200);
check("lobby state is reported", (await text("liveState")) === "In the lobby");
check("lobby is styled as needing attention", (await cls("liveState")).includes("bad"));
check("hint tells you to admit it", (await text("connectHint")).includes("admit it"));

setLive({
  session_id: "s-new",
  status: "in_call",
  meeting: { number: 4 },
  team: { name: "Astra_dev" },
  google_account: "bot@pes.edu",
  counts: { finalLines: 12, questions: 2, answers: 2 },
  error: null,
});
await page.waitForTimeout(3200);
check("in-call state is reported", (await text("liveState")) === "In the call");
check("in-call is styled ok", (await cls("liveState")).includes("ok"));
check("bot account is shown", (await text("liveWhere")).includes("bot@pes.edu"));
const stats = await page.evaluate(() =>
  [...document.querySelectorAll("#liveStats .stat")].map((s) => s.textContent.trim()),
);
check(
  "live counters render",
  JSON.stringify(stats) === JSON.stringify(["12Lines", "2Asked", "2Answered"]),
  JSON.stringify(stats),
);
check("Connect Bot is still not offered", !(await visible("connect")));

// ===========================================================================
console.log("\nD. reopening the popup re-attaches instead of offering Connect");
// ===========================================================================
await page.goto(url); // the popup being closed and clicked again
await page.waitForTimeout(1000);
check("live panel restored on reopen", await visible("live"));
check("Connect Bot is not offered", !(await visible("connect")));
check("Remove Bot is offered", await visible("remove"));
check("status survived the reopen", (await text("liveState")) === "In the call");
check("and no second bot was dispatched", box.dispatchCalls === 1);

await page.screenshot({ path: "data/debug/popup-live.png" });

// ===========================================================================
console.log("\nE. Remove Bot");
// ===========================================================================
await page.click("#remove");
await page.waitForTimeout(500);
check("stop was called", box.stopCalls === 1);
check("button reports leaving", (await text("remove")).startsWith("Leaving"));
check("status reads Leaving", (await text("liveState")) === "Leaving");

setLive({
  session_id: "s-new",
  status: "ended",
  meeting: { number: 4 },
  team: { name: "Astra_dev" },
  counts: { finalLines: 12, questions: 2, answers: 2 },
  error: null,
});
await page.waitForTimeout(3200);
check("status reads Left", (await text("liveState")) === "Left");

setLive(null);
await page.waitForTimeout(4500);
check("returns to Connect Bot after it has left", await visible("connect"));
check("Remove Bot is hidden again", !(await visible("remove")));
check("team select is unlocked", await page.evaluate(() => !document.getElementById("team").disabled));

await page.screenshot({ path: "data/debug/popup-idle.png" });

console.log(`\n${pass} passed, ${fail} failed\n`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
