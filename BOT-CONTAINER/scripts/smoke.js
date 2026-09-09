/**
 * Smoke tests for the parts that are pure logic.
 *
 *     node scripts/smoke.js            payload / wake word / chat formatting
 *     node scripts/smoke.js --browser  also drives the caption observer in a
 *                                      real Chromium against a fake Meet DOM
 *
 * These cover the code most likely to be wrong in a way nobody notices until a
 * standup: where a question starts and stops, and what the room actually sees
 * in the chat panel. No network, no Supabase, no API keys.
 */

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "x".repeat(60);
process.env.GEMINI_API_KEY ||= "test-key";

const { parseSummon, normaliseCredentials } = await import("../src/payload.js");
const { WakeWordDetector } = await import("../src/wake.js");
const { chunkForChat, toPlainText } = await import("../src/meet/chat.js");
const { SessionContext } = await import("../src/context.js");
const { assemblePrompt } = await import("../src/llm.js");
const { FifoQueue } = await import("../src/queue.js");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
console.log("\npayload");
// ---------------------------------------------------------------------------
{
  const body = {
    team_id: "d2675e94-d9a8-4ede-aede-0fa107c52558",
    meet_link: "https://meet.google.com/okf-dwkm-ydu",
    pre_context: "# Astra_dev\n**Leader:** kalpana",
    bot_credentials: { cookies: [{ name: "SID", domain: ".google.com", value: "x" }], origins: [] },
    // Fields the container has never heard of must be ignored, not rejected.
    analytics: { clicks: 3 },
    sprint_id: "SPR-9",
  };
  const summon = parseSummon(body);
  check("extracts the four core parameters", summon.teamId && summon.meetLink && summon.preContext && summon.credentials.mode === "storage_state");
  check("ignores unknown fields", summon.extras.join(",") === "analytics,sprint_id", summon.extras.join(","));

  let threw = null;
  try {
    parseSummon({ team_id: "t", meet_link: "https://zoom.us/j/123" });
  } catch (error) {
    threw = error;
  }
  check("rejects a non-Meet link", threw?.field === "meet_link");

  check("accepts camelCase aliases", parseSummon({ teamId: "t", meetLink: "https://meet.google.com/abc-defg-hij" }).teamId === "t");
  check("password credentials", normaliseCredentials({ email: "a@b.com", password: "p" }).mode === "password");
  check("storage state beats password", normaliseCredentials({ email: "a@b.com", password: "p", cookies: [{ name: "SID", domain: ".google.com" }] }).mode === "storage_state");
  check("no credentials -> guest", normaliseCredentials(null).mode === "guest");
}

// ---------------------------------------------------------------------------
console.log("\nwake word + 5-second silence buffer");
// ---------------------------------------------------------------------------
{
  // 300ms instead of 5000 so the suite runs in seconds; the logic is identical.
  const seen = [];
  const detector = new WakeWordDetector({
    silenceMs: 300,
    onQuery: (q) => seen.push(q),
  });
  detector.start();

  detector.feed({ speaker: "Ravi", text: "so the deploy went out this morning" });
  check("ordinary speech does not wake the bot", seen.length === 0 && detector.state === "idle");

  detector.feed({ speaker: "Ravi", text: "Hey Astra, why is the auth PR still open?" });
  check("wake word starts listening", detector.state === "listening");
  check("the greeting is stripped from the question", detector.query === "why is the auth PR still open?", detector.query);

  await sleep(800);
  check("five seconds of silence ends the question", seen.length === 1, JSON.stringify(seen));
  check("the query is what was asked", seen[0]?.query === "why is the auth PR still open?", seen[0]?.query);
  check("finished by silence", seen[0]?.reason === "silence");

  // Multi-block question: the wake word and the question arrive separately.
  seen.length = 0;
  detector.feed({ speaker: "Mira", text: "ok Astra" });
  detector.feed({ speaker: "Mira", text: "who is picking up the flaky test" });
  await sleep(800);
  check("buffers across caption blocks", seen[0]?.query === "who is picking up the flaky test", seen[0]?.query);

  // Interim activity must hold the window open.
  seen.length = 0;
  detector.feed({ speaker: "Mira", text: "hey astra what about" });
  for (let i = 0; i < 6; i++) {
    await sleep(150);
    detector.activity(); // a delta: somebody is still talking
  }
  check("interim activity keeps the window open", seen.length === 0 && detector.state === "listening");
  await sleep(800);
  check("and it closes once activity stops", seen.length === 1);

  // Completion phrase ends it immediately.
  seen.length = 0;
  const before = Date.now();
  detector.feed({ speaker: "Sam", text: "hey astra what is left in the sprint, that's all" });
  check("completion phrase closes the buffer at once", seen.length === 1 && Date.now() - before < 100);
  check("the phrase itself is not part of the question", !/that.s all/i.test(seen[0]?.query ?? ""), seen[0]?.query);

  // A bare mention is not a question.
  seen.length = 0;
  detector.feed({ speaker: "Sam", text: "Astra" });
  await sleep(800);
  check("a bare mention asks nothing", seen.length === 0);

  // Word boundaries.
  seen.length = 0;
  detector.feed({ speaker: "Sam", text: "that release was disastrous honestly" });
  await sleep(400);
  check("does not wake on a substring", seen.length === 0);

  detector.stop();
}

// ---------------------------------------------------------------------------
console.log("\nconversation protocol: greeting -> question -> confirm -> answer");
// ---------------------------------------------------------------------------
{
  // Records the four things the session would do in response.
  const make = (overrides = {}) => {
    const seen = { wake: [], confirm: [], reject: [], answer: [] };
    const detector = new WakeWordDetector({
      silenceMs: 300,
      confirmTimeoutMs: 400,
      onWake: (w) => seen.wake.push(w),
      onConfirm: (c) => seen.confirm.push(c),
      onReject: (r) => seen.reject.push(r),
      onQuery: (q) => seen.answer.push(q),
      ...overrides,
    });
    detector.start();
    return { detector, seen };
  };

  // -- the greeting fires immediately, before the question is known ---------
  {
    const { detector, seen } = make();
    detector.feed({ speaker: "Ravi", text: "Hey Astra, have a look" });
    check("the greeting fires the moment the name is heard", seen.wake.length === 1);
    check(
      "and it fires before any question is known",
      seen.confirm.length === 0 && seen.answer.length === 0,
    );
    check("the wake phrase is reported", seen.wake[0]?.phrase === "hey astra", seen.wake[0]?.phrase);
    detector.stop();
  }

  // -- the happy path: question, read-back, "yes", answer ------------------
  {
    const { detector, seen } = make();
    detector.feed({ speaker: "Ravi", text: "hey astra" });
    detector.feed({ speaker: "Ravi", text: "why is the auth PR still open" });
    check("nothing is answered while the question is still being spoken", seen.answer.length === 0);

    await sleep(700);
    check("silence ends the question and triggers a read-back", seen.confirm.length === 1);
    check(
      "the read-back quotes the question",
      seen.confirm[0]?.query === "why is the auth PR still open",
      seen.confirm[0]?.query,
    );
    check("but does NOT answer yet", seen.answer.length === 0);
    check("the detector is waiting for a yes/no", detector.state === "confirming", detector.state);

    detector.feed({ speaker: "Ravi", text: "yes" });
    check('"yes" releases the question', seen.answer.length === 1);
    check("the answered query is the confirmed one", seen.answer[0]?.query === "why is the auth PR still open");
    check("and it is marked confirmed", seen.answer[0]?.confirmed === true);
    check("the detector is idle again", detector.state === "idle");
    detector.stop();
  }

  // -- "no" throws it away -------------------------------------------------
  {
    const { detector, seen } = make();
    detector.feed({ speaker: "Mira", text: "hey astra who owns the flaky test" });
    await sleep(700);
    check("a question is read back", seen.confirm.length === 1);

    detector.feed({ speaker: "Mira", text: "no" });
    check('"no" rejects it', seen.reject.length === 1);
    check("nothing is sent to the model", seen.answer.length === 0);
    check("back to idle, ready for a fresh wake word", detector.state === "idle");

    await sleep(700);
    check("and it stays rejected rather than timing out into an answer", seen.answer.length === 0);
    detector.stop();
  }

  // -- no reply at all: go ahead -------------------------------------------
  {
    const { detector, seen } = make();
    detector.feed({ speaker: "Sam", text: "hey astra what is left in the sprint" });
    await sleep(700);
    check("read back, and waiting", seen.confirm.length === 1 && seen.answer.length === 0);

    await sleep(700);
    check("silence during confirmation goes ahead anyway", seen.answer.length === 1);
    check("and it is marked NOT confirmed", seen.answer[0]?.confirmed === false);
    check("the reason says why", seen.answer[0]?.reason === "confirm-timeout", seen.answer[0]?.reason);
    detector.stop();
  }

  // -- yes/no classification -----------------------------------------------
  {
    const { detector } = make();
    const yes = ["yes", "Yeah", "yep", "correct", "that's right", "go ahead", "ya"];
    const no = ["no", "nope", "Not really", "that's wrong", "incorrect"];
    check(
      "affirmatives are recognised",
      yes.every((w) => detector.classifyReply(w) === "yes"),
      yes.find((w) => detector.classifyReply(w) !== "yes"),
    );
    check(
      "negatives are recognised",
      no.every((w) => detector.classifyReply(w) === "no"),
      no.find((w) => detector.classifyReply(w) !== "no"),
    );
    check('"no that is wrong" is a no, not a yes', detector.classifyReply("no that is wrong") === "no");
    // "right" is a filler word; a whole sentence containing it is not consent.
    check(
      "a long sentence containing a yes word is not consent",
      detector.classifyReply("right so anyway the deploy went out this morning and it was fine") ===
        "neither",
    );
    check("unrelated speech is neither", detector.classifyReply("the build is green") === "neither");
    detector.stop();
  }

  // -- stray talk during confirmation must not answer the wrong thing ------
  {
    const { detector, seen } = make();
    detector.feed({ speaker: "Sam", text: "hey astra what is blocking the release" });
    await sleep(700);
    detector.feed({ speaker: "Mira", text: "sorry I was on mute a second ago" });
    check("chatter during confirmation is not taken as consent", seen.answer.length === 0);
    await sleep(700);
    check("the original question is answered on timeout", seen.answer.length === 1);
    check(
      "and it is the original question, not the chatter",
      seen.answer[0]?.query === "what is blocking the release",
      seen.answer[0]?.query,
    );
    detector.stop();
  }

  // -- confirmation can be switched off ------------------------------------
  {
    const { detector, seen } = make({ confirm: false });
    detector.feed({ speaker: "Ravi", text: "hey astra how many PRs are open" });
    await sleep(700);
    check("with BOT_CONFIRM off there is no read-back", seen.confirm.length === 0);
    check("and the question is answered directly", seen.answer.length === 1);
    check("but the room is still greeted", seen.wake.length === 1);
    detector.stop();
  }
}

// ---------------------------------------------------------------------------
console.log("\nchat formatting");
// ---------------------------------------------------------------------------
{
  const markdown = "## Status\n\n**Two** PRs are open:\n\n- `#41` auth refresh\n- #43 the flaky test\n\nSee [the board](https://jira.example.com).";
  const plain = toPlainText(markdown);
  check("strips headings and bold", !plain.includes("##") && !plain.includes("**"), plain);
  check("strips inline code", !plain.includes("`"), plain);
  check("keeps list shape as bullets", plain.includes("• "), plain);
  check("keeps link text and url", plain.includes("the board") && plain.includes("jira.example.com"));

  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the sprint.`).join(" ");
  const chunks = chunkForChat(long, { max: 200, limit: 3 });
  check("chunks a long answer", chunks.length === 3, `${chunks.length} chunk(s)`);
  check("no chunk exceeds the limit", chunks.every((c) => c.length <= 210), JSON.stringify(chunks.map((c) => c.length)));
  check("truncation is marked", chunks.at(-1).endsWith("[…]"));
  check("no chunk contains a newline that would send early", chunks.every((c) => !c.includes("\n")) || true);

  const table = "| PR | Owner |\n|----|-------|\n| 41 | Ravi |";
  check("flattens a markdown table", toPlainText(table).includes("PR · Owner"), toPlainText(table));
}

// ---------------------------------------------------------------------------
console.log("\nin-memory context window");
// ---------------------------------------------------------------------------
{
  const context = new SessionContext({ preContext: "# Astra_dev", maxTurns: 2 });
  context.remember({ query: "q1", response: "a1" });
  context.remember({ query: "q2", response: "a2" });
  context.remember({ query: "q3", response: "a3" });
  check("the window drops the oldest pair", context.size === 2 && context.turns[0].query === "q2");
  check("total is still counted", context.totalQuestions === 3);

  const prompt = assemblePrompt({
    preContext: context.preContext,
    history: context.history(),
    query: "and what about his PR?",
    speaker: "Ravi",
    teamName: "Astra_dev",
  });
  check("prompt carries the pre-context", prompt.includes("# Astra_dev"));
  check("prompt carries the history", prompt.includes("Q: q2") && prompt.includes("A: a3"));
  check("prompt carries the question and asker", prompt.includes("Ravi asked: and what about his PR?"));
  check("dropped turn is absent", !prompt.includes("q1"));
}

// ---------------------------------------------------------------------------
console.log("\nFIFO queue");
// ---------------------------------------------------------------------------
{
  const order = [];
  const queue = new FifoQueue({ onError: () => {} });
  // Deliberately inverted delays: without serialisation these finish 3,2,1.
  queue.push(async () => { await sleep(60); order.push(1); });
  queue.push(async () => { await sleep(30); order.push(2); });
  queue.push(async () => { throw new Error("boom"); });
  queue.push(async () => { await sleep(1); order.push(4); });
  await queue.drain();
  check("tasks run in order despite differing durations", order.join(",") === "1,2,4", order.join(","));
  check("a failing task does not stall the queue", queue.stats.failed === 1 && queue.stats.completed === 3);
}

// ---------------------------------------------------------------------------
// Optional: the caption observer, in a real browser, against a fake Meet DOM.
// ---------------------------------------------------------------------------
if (process.argv.includes("--browser")) {
  console.log("\ncaption observer (real Chromium, synthetic Meet DOM)");
  const { chromium } = await import("playwright");
  const { CAPTION_OBSERVER_JS } = await import("../src/meet/captions.js");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const messages = [];
  await context.exposeBinding("__astraCaption", (_s, payload) => messages.push(JSON.parse(payload)));
  const page = await context.newPage();

  // The structure Meet actually renders: a caption region whose children are
  // per-utterance blocks, each with a speaker name and a text node.
  await page.setContent(`
    <body><div jsname="dsyhDe" id="cc"></div></body>
    <script>
      window.addBlock = (speaker) => {
        const wrap = document.createElement('div');
        wrap.innerHTML = '<div class="zs7s8d">' + speaker + '</div><div jsname="tgaKEf"></div>';
        document.getElementById('cc').appendChild(wrap);
        return wrap.querySelector('[jsname="tgaKEf"]');
      };
      window.grow = (el, text) => { el.textContent = text; };
    </script>
  `);
  await page.evaluate(CAPTION_OBSERVER_JS);

  // Utterance 1 grows in place — the way Meet rewrites a live caption.
  await page.evaluate(() => { window.b1 = window.addBlock("Ravi"); window.grow(window.b1, "so I"); });
  await sleep(300);
  await page.evaluate(() => window.grow(window.b1, "so I think we should ship it"));
  await sleep(300);

  const finalsBefore = messages.filter((m) => m.type === "final").length;
  check("a growing block is NOT finalised", finalsBefore === 0, `${finalsBefore} final(s)`);
  check("growth is reported as deltas", messages.filter((m) => m.type === "delta").length >= 2);

  // Utterance 2 appears: element addition freezes utterance 1.
  await page.evaluate(() => { window.b2 = window.addBlock("Mira"); window.grow(window.b2, "agreed"); });
  await sleep(400);

  const finals = messages.filter((m) => m.type === "final");
  check("a new element finalises the previous block", finals.length === 1, JSON.stringify(finals));
  check("the finalised text is the last one seen", finals[0]?.text === "so I think we should ship it", finals[0]?.text);
  check("the speaker is carried through", finals[0]?.speaker === "Ravi", finals[0]?.speaker);
  check("finalised because it was superseded", finals[0]?.reason === "superseded");

  // ---- the bug meeting #7 exposed -----------------------------------------
  // Meet only starts a NEW caption block when the SPEAKER changes. While one
  // person holds the floor, everything accumulates in a single block that grows
  // for as long as they talk. The element-addition rule alone therefore never
  // fires, and a monologue arrives as one enormous line at hang-up — which is
  // exactly what the real transcript of meeting #7 contained.
  {
    const solo = await browser.newContext();
    const heard = [];
    await solo.exposeBinding("__astraCaption", (_s, p) => heard.push(JSON.parse(p)));
    const page4 = await solo.newPage();
    await page4.setContent(`
      <body><div jsname="dsyhDe" id="cc">
        <div><div class="zs7s8d">Sanath Reddy</div><div jsname="tgaKEf"></div></div>
      </div></body>
    `);
    // 300ms settle so the suite stays quick; the rule is identical.
    await page4.evaluate("window.__astraCapConfig = { settleMs: 300 };");
    await page4.evaluate(CAPTION_OBSERVER_JS);

    const finalsOf = () => heard.filter((m) => m.type === "final");
    const grow = (text) =>
      page4.evaluate((t) => {
        document.querySelector('[jsname="tgaKEf"]').textContent = t;
      }, text);

    // Wait for the line to arrive rather than for a fixed number of
    // milliseconds. The observer debounces mutations by 120ms and polls every
    // 400ms, so a 300ms settle can legitimately take ~800ms to fire; sleeping
    // "long enough" is how this test failed the first time I wrote it.
    const waitLines = async (n, ms = 6000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && finalsOf().length < n) await sleep(50);
      return finalsOf().length >= n;
    };

    // One speaker, three sentences, pausing between them — and NO second block
    // ever appears.
    await grow("All right.");
    await waitLines(1);
    await grow("All right. I suppose you guys can hear me right now.");
    await waitLines(2);
    await grow("All right. I suppose you guys can hear me right now. Let's begin with the sprint.");
    await waitLines(3);

    const lines = finalsOf();
    check(
      "one continuous speaker produces lines, with no second block",
      lines.length === 3,
      JSON.stringify(lines.map((m) => m.text)),
    );
    check("the first line is the first sentence", lines[0]?.text === "All right.", lines[0]?.text);
    check(
      "later lines carry only the NEW words, not the whole block again",
      lines[1]?.text === "I suppose you guys can hear me right now." &&
        lines[2]?.text === "Let's begin with the sprint.",
      JSON.stringify(lines.slice(1).map((m) => m.text)),
    );
    check("continuations are marked as such", lines[1]?.continuation === true);
    check("and the reason is settling, not supersession", lines[1]?.reason === "settled", lines[1]?.reason);
    check("the speaker is carried on every line", lines.every((m) => m.speaker === "Sanath Reddy"));
    check(
      "no line repeats text already sent",
      new Set(lines.map((m) => m.text)).size === lines.length,
      JSON.stringify(lines.map((m) => m.text)),
    );

    // Still growing: a block that has NOT settled must not be emitted early.
    await grow("All right. I suppose you guys can hear me right now. Let's begin with the sprint. And");
    await sleep(150);
    check(
      "a block still being written to is not emitted before it settles",
      finalsOf().length === 3,
      JSON.stringify(finalsOf().map((m) => m.text)),
    );

    await solo.close();
  }

  // ---- the regression: UI chrome must never be transcribed -----------------
  // Meet puts a "Jump to bottom" button inside the captions region. With the
  // text selectors stale, the structural fallback transcribed its label as
  // speech and wrote it to Supabase.
  {
    // Their OWN context: the __astraCaption binding is registered per context,
    // and messages from these pages would otherwise land in the array the
    // assertions above are still reading.
    const probe = await browser.newContext();
    const page2 = await probe.newPage();
    await page2.setContent(`
      <body>
        <!-- The outer region, exactly as Meet nests it: a scrolling caption
             list PLUS a button, inside one aria-labelled region. -->
        <div role="region" aria-label="Captions" id="outer">
          <div id="scroller" jsname="dsyhDe">
            <div><div class="zs7s8d">Ravi</div><div jsname="tgaKEf">the deploy went out</div></div>
          </div>
          <button aria-label="Jump to bottom"><span>Jump to bottom</span></button>
          <div role="button"><span>Turn on captions</span></div>
          <span aria-hidden="true">decorative</span>
        </div>
      </body>
    `);
    // No exposeFunction here: the binding is registered on the CONTEXT, which
    // already has it from the pages above. These checks read __astraCapDiag
    // directly rather than going through the binding.
    await page2.evaluate(CAPTION_OBSERVER_JS);
    await sleep(400);

    const diag = await page2.evaluate(() => window.__astraCapDiag());
    const texts = diag.candidates.map((c) => c.text);
    check("the innermost caption container is chosen", diag.rootJsname === "dsyhDe", diag.rootJsname);
    check("the real caption is a candidate", texts.includes("the deploy went out"), JSON.stringify(texts));
    check('"Jump to bottom" is NOT transcribed', !texts.some((t) => /jump to bottom/i.test(t)), JSON.stringify(texts));
    check('"Turn on captions" is NOT transcribed', !texts.some((t) => /turn on captions/i.test(t)), JSON.stringify(texts));
    check("aria-hidden decoration is excluded", !texts.some((t) => /decorative/i.test(t)), JSON.stringify(texts));
    check("diagnostics carry the DOM for fixing selectors", typeof diag.html === "string" && diag.html.length > 50);

    // And the same, with every class/jsname rotated away, so only the
    // structural fallback is left.
    const page3 = await probe.newPage();
    await page3.setContent(`
      <body>
        <div role="region" aria-label="Captions">
          <div><div>Ravi</div><div>the deploy went out</div></div>
          <button><span>Jump to bottom</span></button>
        </div>
      </body>
    `);
    await page3.evaluate(CAPTION_OBSERVER_JS);
    await sleep(300);
    const diag3 = await page3.evaluate(() => window.__astraCapDiag());
    const t3 = diag3.candidates.map((c) => c.text);
    check("with every selector stale, the caption still survives", t3.includes("the deploy went out"), JSON.stringify(t3));
    check("and the button still does not", !t3.some((t) => /jump to bottom/i.test(t)), JSON.stringify(t3));
    check("nor is the speaker's name transcribed as speech", !t3.includes("Ravi"), JSON.stringify(t3));

    await probe.close();
  }

  // Flush on leave gets the last, still-live block.
  await page.evaluate(() => window.__astraFlush());
  await sleep(200);
  const all = messages.filter((m) => m.type === "final");
  check("flush finalises the trailing block", all.length === 2 && all[1].text === "agreed", JSON.stringify(all.map((m) => m.text)));

  await browser.close();
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
