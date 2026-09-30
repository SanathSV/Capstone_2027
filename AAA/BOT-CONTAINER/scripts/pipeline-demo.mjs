/**
 * The full caption -> transcript -> Supabase pipeline, with the log markers.
 *
 *     node scripts/pipeline-demo.mjs            run it, then delete the rows
 *     node scripts/pipeline-demo.mjs --keep     leave the meeting in the database
 *
 * A real BotSession, a real meeting row, real Supabase inserts and a real
 * Gemini call. The only thing stubbed is the browser: caption messages are fed
 * straight into `_onCaption` in the same shape the injected observer sends
 * them, and chat posts are collected instead of typed into Meet.
 *
 * So the markers printed below are the markers a live meeting prints. This is
 * how to check the wiring without getting four people into a call.
 */
import { BotSession } from "../src/session.js";
import { parseSummon } from "../src/payload.js";
import { supabase } from "../src/db.js";
import { config } from "../src/config.js";
import { readFile } from "node:fs/promises";

const KEEP = process.argv.includes("--keep");
const TEAM = process.env.DEMO_TEAM_ID ?? "d2675e94-d9a8-4ede-aede-0fa107c52558";

let preContext = "# Demo team\n| Person | Commits |\n|---|---|\n| Ravi | 4 |";
try {
  const dump = JSON.parse(
    await readFile("../astra-platform/_sent_data_extension/latest.json", "utf8"),
  );
  preContext = dump.body?.pre_context ?? preContext;
} catch {
  /* fall back to the stub above */
}

const session = new BotSession(
  parseSummon({
    team_id: TEAM,
    meet_link: "https://meet.google.com/abc-defg-hij",
    pre_context: preContext,
  }),
);

// No browser: collect chat instead of typing it into Meet. Everything else —
// the queues, the detector, Supabase, Gemini — is the real thing.
const chat = [];
session._say = (text) => {
  chat.push(text);
  console.log(`  💬 CHAT  ${text}`);
  return Promise.resolve(1);
};

console.log(`\nmodel   : ${config.geminiModel}`);
console.log(`team    : ${TEAM}`);
console.log(`markers : BOT_LOG_TRANSCRIPT=${config.logTranscript} BOT_LOG_DB=${config.logDbWrites}\n`);

console.log("── opening the meeting row ───────────────────────────────────");
await session.prepare();

// Shortened so the demo is not mostly waiting; the logic is identical.
session.detector.silenceMs = 1200;
session.detector.confirmTimeoutMs = 1500;
session.detector.start();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exactly the shape src/meet/captions.js sends over the exposed binding. */
const caption = async (speaker, text, gap = 250) => {
  session._onCaption({ type: "final", id: String(Math.random()), speaker, text, ts: Date.now() });
  await sleep(gap);
};

console.log("\n── the meeting ───────────────────────────────────────────────");
await caption("Ravi", "morning everyone, the deploy went out at seven");
await caption("Mira", "nice, did the migration run cleanly");
await caption("Ravi", "it did, no errors in the log");
await caption("Sam", "Hey Astra");
await caption("Sam", "who has the most commits this sprint");
await sleep(1800); // silence closes the question -> read-back
await caption("Sam", "yes");

await session.answerQueue.drain();
await session.transcriptQueue.drain();
session.detector.stop();

console.log("\n── what actually reached Supabase ────────────────────────────");
const { data: rows, error } = await supabase()
  .from("transcripts")
  .select("speaker_name, content, kind, spoken_at")
  .eq("meeting_id", session.meeting.id)
  .order("spoken_at", { ascending: true });

if (error) {
  console.log("  read-back failed:", error.message);
} else {
  for (const r of rows) {
    console.log(
      `  ${r.kind.padEnd(8)} ${r.speaker_name.padEnd(14)} » ${r.content.slice(0, 88)}`,
    );
  }
  console.log(`\n  ${rows.length} row(s) in public.transcripts for meeting ${session.meeting.id}`);
}

const { data: meeting } = await supabase()
  .from("meetings")
  .select("meeting_number, status, team_ref")
  .eq("id", session.meeting.id)
  .single();
console.log(
  `  meetings row: #${meeting?.meeting_number} status=${meeting?.status} team_ref=${meeting?.team_ref}`,
);

console.log(
  `\n  counters: ${session.counts.rowsWritten} written, ${session.counts.rowsFailed} failed, ` +
    `${session.counts.questions} question(s), ${session.counts.answers} answer(s)`,
);

if (KEEP) {
  console.log(`\nKept. Meeting id ${session.meeting.id}`);
} else {
  // transcripts cascade on delete, so the demo leaves nothing behind.
  await supabase().from("meetings").delete().eq("id", session.meeting.id);
  console.log("\nCleaned up (pass --keep to leave the rows in place).");
}
process.exit(session.counts.rowsFailed ? 1 : 0);
