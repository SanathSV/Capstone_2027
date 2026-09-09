import { config } from "../config.js";

/**
 * Writing the bot's answer into the Google Meet in-call chat.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FORMATTING WORK IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * An LLM returns markdown by default: `**bold**`, `##` headings, bullet lists,
 * fenced code. Meet's chat renders none of it. Pasted verbatim, the room sees
 * literal asterisks and hash marks in a narrow panel — which reads as a broken
 * bot even when the answer is perfect.
 *
 * There is a second, sharper reason. In Meet's chat box **Enter sends the
 * message**. A multi-line answer typed straight in therefore does not produce
 * one message with line breaks; it produces one message per line, each fired
 * the instant a newline is typed, spraying half-sentences into the meeting. So
 * newlines have to be dealt with deliberately, one way or the other, before a
 * single keystroke is sent.
 *
 * The approach: strip the markup, then split into a small number of whole
 * messages at sentence boundaries and send them in order. Meet renders each as
 * its own chat bubble, which is more readable in a narrow panel than one wall
 * of text, and it keeps every individual message inside the length Meet will
 * accept.
 */

const CHAT_BOX =
  'textarea[aria-label*="Send a message" i], ' +
  'textarea[placeholder*="Send a message" i], ' +
  'div[role="textbox"][aria-label*="message" i], ' +
  'textarea[aria-label*="message" i]';

const CHAT_OPEN =
  'button[aria-label*="Chat with everyone" i], button[aria-label*="chat" i]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Markdown -> something a human reads comfortably in a chat panel.
 *
 * Bullets become "• " rather than being dropped: the shape of a list is useful
 * information, and the bullet character survives where the markdown does not.
 */
export function toPlainText(markdown) {
  let text = String(markdown ?? "");

  text = text.replace(/```[a-z]*\n?/gi, "").replace(/```/g, ""); // fences
  text = text.replace(/`([^`]+)`/g, "$1"); // inline code
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)"); // links
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, ""); // headings
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1"); // bold
  text = text.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2"); // italics
  text = text.replace(/^\s{0,4}[-*+]\s+/gm, "• "); // bullets
  text = text.replace(/^\s{0,4}>\s?/gm, ""); // block quotes
  text = text.replace(/^\s*\|.*\|\s*$/gm, (row) =>
    // A markdown table is unreadable in chat; flatten a row to " · " separated
    // cells and drop the |---|---| separator line entirely.
    /^[\s|:-]+$/.test(row) ? "" : row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()).join(" · "),
  );
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

/**
 * Break an answer into whole messages.
 *
 * Splitting happens at paragraph, then sentence, then (only as a last resort)
 * character boundaries, so a message never ends mid-word. Anything past
 * `chatMaxChunks` is dropped with a marker rather than silently truncated —
 * the room should know there was more.
 */
export function chunkForChat(text, { max = config.chatChunkChars, limit = config.chatMaxChunks } = {}) {
  const clean = toPlainText(text);
  if (!clean) return [];

  const pieces = [];
  let current = "";

  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };

  // Paragraphs first: they are the author's own idea of a break.
  for (const paragraph of clean.split(/\n{2,}/)) {
    const block = paragraph.trim();
    if (!block) continue;

    if (current.length + block.length + 2 <= max) {
      current = current ? `${current}\n${block}` : block;
      continue;
    }
    flush();

    if (block.length <= max) {
      current = block;
      continue;
    }
    // Too long even alone: split on sentence ends, keeping the punctuation.
    for (const sentence of block.match(/[^.!?\n]+[.!?]*\s*/g) ?? [block]) {
      if (current.length + sentence.length <= max) {
        current += sentence;
      } else {
        flush();
        current = sentence.length <= max ? sentence : sentence.slice(0, max);
      }
    }
  }
  flush();

  if (pieces.length > limit) {
    const kept = pieces.slice(0, limit);
    kept[limit - 1] += " […]";
    return kept;
  }
  return pieces;
}

/**
 * The chat input, but only once it is genuinely usable.
 *
 * Presence is not enough: the textarea exists in the DOM while the panel is
 * closed, so a `count()` check would skip opening the panel and then type into
 * a hidden box — which fails silently, with the answer going nowhere.
 */
async function visibleChatBox(page) {
  try {
    const box = page.locator(CHAT_BOX).first();
    if ((await box.count()) && (await box.isVisible())) return box;
  } catch {
    /* mid-render */
  }
  return null;
}

async function openChatPanel(page) {
  try {
    const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    await page.mouse.move(w / 2, h - 40); // wake the faded toolbar
    await sleep(400);
    const button = page.locator(CHAT_OPEN).first();
    await button.waitFor({ state: "visible", timeout: 4000 });
    await button.click({ timeout: 4000 });
    await sleep(1200);
    return true;
  } catch {
    return false;
  }
}

/**
 * Post one message. Newlines are flattened here as the final safety net — by
 * this point `chunkForChat` should have produced a single paragraph, but a
 * stray newline reaching `type()` would send the message early and split it.
 */
async function sendOne(page, message, log) {
  const line = message.replace(/\s*\n\s*/g, "  ").trim();
  if (!line) return false;

  let box = await visibleChatBox(page);
  if (!box) {
    await openChatPanel(page);
    box = await visibleChatBox(page);
  }
  if (!box) {
    log.warn("could not find the chat box; the answer was not posted");
    return false;
  }

  try {
    await box.click({ timeout: 4000 });
    await box.fill(line, { timeout: 4000 });
    await page.keyboard.press("Enter");
    await sleep(400);
    return true;
  } catch (error) {
    log.warn(`could not send a chat message: ${error.message}`);
    return false;
  }
}

/**
 * Send an answer to the room.
 *
 * The first message is prefixed so people can tell the bot's replies from each
 * other's, and continuations are marked so a two-part answer does not read as
 * two unrelated ones.
 */
export async function sendAnswer(page, answer, log, { prefix = "🤖 Astra: " } = {}) {
  const chunks = chunkForChat(answer);
  if (!chunks.length) {
    log.warn("nothing to send — the answer was empty after formatting");
    return 0;
  }

  let sent = 0;
  for (let i = 0; i < chunks.length; i++) {
    const body = i === 0 ? `${prefix}${chunks[i]}` : `↳ ${chunks[i]}`;
    if (await sendOne(page, body, log)) sent += 1;
    // A short gap keeps Meet from coalescing rapid messages, and reads more
    // naturally to the room than three bubbles appearing at once.
    if (i < chunks.length - 1) await sleep(700);
  }

  // The words, not a count. "answered in chat (1/1 message(s), 25 chars)" tells
  // you something happened without telling you what, which is the least useful
  // possible line in a log somebody is reading to follow a conversation.
  if (sent < chunks.length) log.warn(`only ${sent} of ${chunks.length} chat message(s) sent`);
  return sent;
}

export { CHAT_BOX, CHAT_OPEN };
