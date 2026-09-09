/**
 * The whole conversation loop, end to end, with a REAL Gemini call.
 *
 *     node scripts/conversation-demo.mjs
 *
 * Everything is real except the room: the same WakeWordDetector the session
 * uses, wired to the same callbacks, fed simulated caption lines, with the
 * team's actual pre-context and a live call to the configured model. What it
 * prints is what the meeting chat would show, in order.
 *
 * This is the fastest way to answer "is the bot actually talking to Gemini?"
 * without getting four people into a call.
 */
import { readFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { WakeWordDetector } from "../src/wake.js";
import { SessionContext } from "../src/context.js";
import { assemblePrompt, ask } from "../src/llm.js";
import { toPlainText, chunkForChat } from "../src/meet/chat.js";
import { FifoQueue } from "../src/queue.js";

const PRE_CONTEXT_FILE = "../astra-platform/_sent_data_extension/latest.json";

let preContext = "";
try {
  const dump = JSON.parse(await readFile(PRE_CONTEXT_FILE, "utf8"));
  preContext = dump.body?.pre_context ?? "";
} catch {
  preContext = "# Demo team\n## Team\n| Person | Role | Commits |\n|---|---|---|\n| Ravi | Engineer | 4 |";
}

console.log(`\nmodel        : ${config.geminiModel}`);
console.log(`pre-context  : ${preContext.length} chars (~${Math.ceil(preContext.length / 4)} tokens)`);
console.log(
  `confirm      : ${config.confirmEnabled ? `on, ${config.confirmTimeoutMs}ms` : "off — the answer's own opener restates the question"}`,
);
console.log(`humour       : ${config.humour ? "on" : "off"}`);
console.log(`silence      : ${config.silenceMs}ms\n`);

const context = new SessionContext({ preContext, teamName: "Astra_dev" });
const chat = [];
const say = (text) => {
  chat.push(text);
  console.log(`  💬 CHAT  ${text}`);
};

// The same serialisation the session uses, so ordering here matches production.
const answerQueue = new FifoQueue({ onError: (e) => console.log("  ERROR", e.message) });

const detector = new WakeWordDetector({
  // Shortened so the demo does not take a minute; the logic is identical.
  silenceMs: 1200,
  confirmTimeoutMs: 2000,
  onWake: () => say(config.greeting),
  onConfirm: ({ query }) => say(`If I'm not wrong, you're asking: "${query}" — yes or no?`),
  onReject: () => say(config.rejectedReply),
  onQuery: ({ query, speaker, confirmed, reason }) => {
    console.log(`  →  asking Gemini (${reason}${confirmed ? ", confirmed" : ", unconfirmed"})`);
    answerQueue.push(async () => {
      const prompt = assemblePrompt({
        preContext: context.preContext,
        history: context.history(),
        query,
        speaker,
        teamName: "Astra_dev",
      });
      const started = Date.now();
      const answer = await ask(prompt);
      const clean = toPlainText(answer);
      console.log(`  ←  Gemini replied in ${Date.now() - started}ms`);
      for (const chunk of chunkForChat(answer)) say(`🤖 Astra: ${chunk}`);
      context.remember({ query, response: clean, speaker });
    });
  },
});
detector.start();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const speak = async (speaker, text, gap = 300) => {
  console.log(`  🎤 ${speaker}: ${text}`);
  detector.feed({ speaker, text });
  await sleep(gap);
};

// ---------------------------------------------------------------------------
console.log("── 1. wake, greeting, question, answer ──────────────────────");
// ---------------------------------------------------------------------------
await speak("Ravi", "so the deploy went out this morning");
await speak("Ravi", "Hey Astra, have a look");
await speak("Ravi", "who has the most commits this sprint");
await sleep(1800); // silence closes the question -> straight to the model
await answerQueue.drain();

// ---------------------------------------------------------------------------
console.log("\n── 2. a follow-up, using the in-memory context ───────────────");
// ---------------------------------------------------------------------------
await speak("Mira", "hey astra is that person blocked on anything");
await sleep(1800);
await answerQueue.drain();

// ---------------------------------------------------------------------------
console.log("\n── 3. a question the context cannot answer ───────────────────");
// ---------------------------------------------------------------------------
// The opener still restates it, so the room can see the question was heard even
// when the answer is "I don't have that".
await speak("Sam", "hey astra what is the flaky test situation");
await sleep(1800);
await answerQueue.drain();

// ---------------------------------------------------------------------------
console.log("\n── 4. a completion phrase ends the question early ────────────");
// ---------------------------------------------------------------------------
await speak("Sam", "hey astra what should we focus on tomorrow, that's all");
await answerQueue.drain();

detector.stop();

console.log(`\n${chat.length} chat message(s), ${context.size} exchange(s) held in memory.`);
console.log(`Gemini calls: ${answerQueue.stats.completed} ok, ${answerQueue.stats.failed} failed.\n`);
process.exit(answerQueue.stats.failed ? 1 : 0);
