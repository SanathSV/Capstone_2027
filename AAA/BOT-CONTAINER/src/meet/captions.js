/**
 * The caption scraper: DOM element-addition delta logic.
 *
 * ===========================================================================
 * HOW GOOGLE MEET RENDERS CAPTIONS, AND WHY THAT DICTATES THIS DESIGN
 * ===========================================================================
 * Meet does not emit finished sentences. It renders a caption *block* per
 * utterance and rewrites that block in place as speech recognition catches up:
 *
 *     "so I"  ->  "so I think"  ->  "so I think we should ship it"
 *
 * When the speaker stops, or a different person starts, Meet stops touching
 * that block and **appends a new sibling element** for the next utterance. The
 * old block is then frozen: it will never change again.
 *
 * That gives an exact, event-driven finalisation signal that needs no timer and
 * no guessing:
 *
 *     A caption block is FINAL the moment a newer block element appears
 *     after it — or the moment it is removed from the caption region.
 *
 * This is what the spec calls element-addition delta logic, and it is strictly
 * better than the obvious alternative of "emit a block once it has been quiet
 * for N seconds". A timer either truncates slow speakers (N too small) or
 * delays every line by N (N too large); the DOM already knows the answer.
 *
 * ===========================================================================
 * TWO KINDS OF MESSAGE, AND WHY BOTH ARE NEEDED
 * ===========================================================================
 *   delta  — a tracked block's text changed. Not written to the database and
 *            not fed to the LLM. Its only job is to say "somebody is still
 *            talking", which is what the wake-word detector's five-second
 *            silence window is measured against. Without it, a ten-second
 *            sentence looks like ten seconds of silence.
 *
 *   final  — a block froze. This is a real utterance: it goes on the FIFO queue
 *            for Supabase and into the wake-word detector.
 *
 * Selectors are prioritised lists that degrade to a structural heuristic,
 * because Google rotates the obfuscated class names without notice. If every
 * name changes at once the structural fallback still finds leaf elements
 * carrying text inside the caption region.
 */

export const CAPTION_OBSERVER_JS = String.raw`
(() => {
  if (window.__astraCapInstalled) return 'already-installed';
  window.__astraCapInstalled = true;

  const ROOT_SELECTORS = [
    'div[jsname="dsyhDe"]',
    'div.a4cQT',
    'div[role="region"][aria-label*="aption" i]',
    'div[aria-label*="aption" i][aria-live]',
  ];
  const TEXT_SELECTORS = [
    'div[jsname="tgaKEf"]',
    'div.iTTPOb',
    'div.bh44bd',
    'div.VbkSUe',
  ];
  const NAME_SELECTORS = [
    'div.zs7s8d',
    'div.KcIKyf',
    'span.NWpY1d',
    'div.jxFHg',
  ];

  // How long a block must sit unchanged before the part of it not yet emitted
  // counts as a finished thought. Set from Node; see the SETTLING rule below.
  const SETTLE_MS = (window.__astraCapConfig && window.__astraCapConfig.settleMs) || 2000;

  let seq = 0;
  // id -> { el, speaker, text, emitted, changedAt, final }
  //   text     what the block currently says
  //   emitted  how much of that has already gone out as a final line
  const blocks = new Map();

  const send = (message) => {
    try {
      window.__astraCaption(JSON.stringify(message));
    } catch (e) {
      // The binding is torn down during navigation and while the page unloads.
      // Losing a caption there is correct; throwing would kill the observer.
    }
  };

  // Anything a person could click, or that is hidden from screen readers, is
  // interface -- not speech. This exists because of a real bug: Meet puts a
  // "Jump to bottom" button INSIDE the captions region, the text selectors went
  // stale, and the structural fallback below happily transcribed the button's
  // label as though somebody had said it.
  const INTERACTIVE =
    'button, a, input, textarea, select, [role="button"], [role="link"], ' +
    '[role="menuitem"], [role="menuitemradio"], [role="tab"], [role="checkbox"], ' +
    '[role="switch"], [role="slider"], [role="tooltip"], [role="dialog"]';

  const isChrome = (el) =>
    Boolean(el.closest(INTERACTIVE)) || Boolean(el.closest('[aria-hidden="true"]'));

  const findRoot = () => {
    const matches = [];
    for (const sel of ROOT_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) matches.push(el);
    }
    if (!matches.length) return null;
    // Prefer the INNERMOST match. Meet nests the scrolling caption list inside
    // a wider region that also holds toolbar buttons, so scraping the outer one
    // picks up interface text; the inner one contains only utterances.
    const innermost = matches.filter(
      (el) => !matches.some((other) => other !== el && el.contains(other))
    );
    return innermost[0] || matches[0];
  };

  const textNodesIn = (root) => {
    for (const sel of TEXT_SELECTORS) {
      const found = Array.from(root.querySelectorAll(sel)).filter((el) => !isChrome(el));
      if (found.length) return found;
    }
    // Structural fallback, for when Google rotates every class name at once.
    // Leaf elements carrying text, minus the interface and minus the speaker
    // labels -- a name is not something the speaker said.
    const nameSel = NAME_SELECTORS.join(',');
    const leaves = Array.from(root.querySelectorAll('div, span')).filter((el) => {
      if (el.childElementCount !== 0) return false;
      if (!(el.textContent || '').trim()) return false;
      if (isChrome(el)) return false;
      if (nameSel && el.matches(nameSel)) return false;
      return true;
    });

    // With the name selectors stale too, the speaker label is just another leaf
    // and would be transcribed as though the speaker had said their own name.
    // Meet renders a caption block as name-then-text, so within any block that
    // has more than one text leaf, the first is the label. Blocks with a single
    // leaf are left alone -- that is the utterance.
    const byBlock = new Map();
    for (const el of leaves) {
      let block = el.parentElement;
      while (block && block.parentElement && block.parentElement !== root) {
        block = block.parentElement;
      }
      const key = block || root;
      if (!byBlock.has(key)) byBlock.set(key, []);
      byBlock.get(key).push(el);
    }
    const dropped = new Set();
    for (const group of byBlock.values()) {
      if (group.length > 1) dropped.add(group[0]);
    }
    return leaves.filter((el) => !dropped.has(el));
  };

  /**
   * What the observer can actually see, for when it sees the wrong thing.
   *
   * Selector rot is silent: captions simply stop arriving, or -- worse -- the
   * wrong text arrives and looks like a transcription bug. Guessing new class
   * names from the outside is hopeless, so this hands back the real DOM to fix
   * them from. Read by dumpCaptionDiagnostics() on the Node side.
   */
  window.__astraCapDiag = () => {
    const root = findRoot();
    const matched = [];
    for (const sel of ROOT_SELECTORS) {
      if (document.querySelector(sel)) matched.push(sel);
    }
    const textSelHits = {};
    for (const sel of TEXT_SELECTORS) {
      textSelHits[sel] = root ? root.querySelectorAll(sel).length : 0;
    }
    const describe = (el) => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 60),
      jsname: el.getAttribute('jsname'),
      chrome: isChrome(el),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90),
    });
    return {
      rootFound: Boolean(root),
      rootSelectorsMatched: matched,
      rootTag: root ? root.tagName : null,
      rootClass: root ? (root.className || '').toString().slice(0, 80) : null,
      rootJsname: root ? root.getAttribute('jsname') : null,
      textSelectorHits: textSelHits,
      candidates: root ? textNodesIn(root).slice(0, 12).map(describe) : [],
      // Every leaf with text, chrome included, so a stale selector can be
      // replaced by reading what is actually there.
      allLeaves: root
        ? Array.from(root.querySelectorAll('div, span'))
            .filter((el) => el.childElementCount === 0 && (el.textContent || '').trim())
            .slice(0, 30)
            .map(describe)
        : [],
      html: root ? root.outerHTML.slice(0, 20000) : null,
    };
  };

  const speakerFor = (textEl, root) => {
    let block = textEl.parentElement;
    for (let hop = 0; hop < 4 && block && block !== root; hop++) {
      for (const sel of NAME_SELECTORS) {
        const n = block.querySelector(sel);
        const v = n && (n.textContent || '').trim();
        if (v && !textEl.contains(n)) return v;
      }
      // Meet renders the speaker's avatar beside the name; its alt text is the
      // most stable carrier of the name there is.
      const img = block.querySelector('img[alt]');
      const alt = img && (img.getAttribute('alt') || '').trim();
      if (alt) return alt;
      block = block.parentElement;
    }
    return 'Unknown';
  };

  // A finalised block is kept in the map, marked, rather than deleted. Its
  // element is usually still on screen -- Meet keeps two or three visible --
  // and forgetting it would make the next scan treat it as brand new, emit it
  // again, and put a duplicate line in the transcript. The entry is dropped in
  // the sweep below, once the element has actually left the DOM.
  // Emit whatever part of a block has not been sent yet.
  //
  // The "close" flag says whether the block is done for good (a newer one appeared, or
  // it left the DOM) or merely paused. A paused block stays tracked and can
  // emit again when the speaker carries on, which is what turns one continuous
  // speaker into a stream of sentences instead of one blob at hang-up.
  const emit = (id, entry, reason, close) => {
    if (entry.final) return;
    if (close) entry.final = true;

    const whole = (entry.text || '').trim();
    // Meet grows a block in place, so the new part is the suffix. When the text
    // does NOT extend what was already sent, Meet recycled the row for a fresh
    // utterance and the whole of it is new.
    const isGrowth = Boolean(entry.emitted) && whole.startsWith(entry.emitted);
    const part = (isGrowth ? whole.slice(entry.emitted.length) : whole).trim();
    entry.emitted = whole;
    if (!part) return;

    send({
      type: 'final',
      id: id,
      speaker: entry.speaker || 'Unknown',
      text: part,
      continuation: isGrowth,
      reason: reason,
      ts: Date.now(),
    });
  };

  const scan = () => {
    const root = findRoot();
    if (!root) return;
    window.__astraCapRootSeen = true;

    const live = textNodesIn(root);
    const seen = new Set();

    for (let i = 0; i < live.length; i++) {
      const el = live[i];
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;

      if (!el.dataset.astraCapId) el.dataset.astraCapId = String(++seq);
      const id = el.dataset.astraCapId;
      seen.add(id);

      let entry = blocks.get(id);
      if (!entry) {
        entry = {
          el: el,
          speaker: speakerFor(el, root),
          text: '',
          emitted: '',
          changedAt: Date.now(),
          final: false,
        };
        blocks.set(id, entry);
      }
      if (entry.final) continue;

      if (entry.text !== text) {
        entry.text = text;
        entry.changedAt = Date.now();
        entry.speaker = speakerFor(el, root) || entry.speaker;
        // Interim: proof that somebody is mid-sentence. Resets the silence
        // window; never persisted.
        send({ type: 'delta', id: id, speaker: entry.speaker, text: text, ts: Date.now() });
      }
    }

    // ---- TWO RULES, AND BOTH ARE NEEDED ---------------------------------
    //
    // 1. ELEMENT ADDITION. Every tracked block except the newest is frozen:
    //    Meet has moved on to a later element and will not touch it again.
    //    This fires on a SPEAKER CHANGE, which is the only time Meet starts a
    //    new block.
    //
    // 2. SETTLING. Rule 1 alone is not enough, and the gap is not a corner
    //    case: while ONE person talks, Meet keeps appending to a SINGLE block
    //    for as long as they hold the floor. No new element ever appears, so
    //    nothing is finalised, and a ten-minute monologue arrives as one
    //    enormous line when the bot finally leaves. That is exactly what
    //    happened in meeting #7 — a single row holding several sentences,
    //    which is also why nothing appeared in the log during the meeting.
    //
    //    So a block that has sat unchanged for SETTLE_MS emits the part of
    //    itself not yet sent, and stays tracked. The pauses a speaker leaves
    //    between sentences are what turn their monologue into lines.
    const now = Date.now();
    const newest = live.length ? live[live.length - 1].dataset.astraCapId : null;

    for (const [id, entry] of Array.from(blocks.entries())) {
      if (!seen.has(id)) {
        // The element left the DOM entirely — scrolled out of the caption
        // region. Whatever it last said is final, and nothing can revive it,
        // so this is the one place an entry is safe to forget.
        emit(id, entry, 'removed', true);
        blocks.delete(id);
      } else if (id !== newest) {
        emit(id, entry, 'superseded', true);
      } else if (entry.text !== entry.emitted && now - entry.changedAt >= SETTLE_MS) {
        emit(id, entry, 'settled', false);
      }
    }
  };

  // Meet mutates its DOM constantly; coalesce a burst into one scan.
  let pending = null;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; scan(); }, 120);
  };

  const install = (root) => {
    // childList is the signal the delta rule is built on: a new caption block
    // is an added child. subtree + characterData additionally give us the
    // in-place rewrites that produce 'delta' messages.
    window.__astraCapObserver = new MutationObserver(schedule);
    window.__astraCapObserver.observe(root, {
      childList: true, subtree: true, characterData: true,
    });
    // Safety net: a missed mutation batch (throttled tab, re-render) would
    // otherwise strand a block forever.
    // 400ms: the settling rule is only as punctual as this interval, and a line
    // that appears a second late in a live meeting is a line people have
    // already moved past.
    window.__astraCapPoll = setInterval(scan, 400);
    scan();
  };

  // Force everything out — called from Node when the bot leaves the call, so
  // the last thing anybody said is not lost with the browser.
  window.__astraFlush = () => {
    scan();
    for (const [id, entry] of Array.from(blocks.entries())) emit(id, entry, 'flush', true);
    return true;
  };

  const boot = () => {
    const root = findRoot();
    if (root) { install(root); return; }
    // Captions may not be on yet. Watch the body until the region appears,
    // then narrow the observer down to it.
    const waiter = new MutationObserver(() => {
      const found = findRoot();
      if (found) { waiter.disconnect(); install(found); }
    });
    waiter.observe(document.documentElement, { childList: true, subtree: true });
    window.__astraCapWaiter = waiter;
  };

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  return 'installed';
})()
`;

/**
 * Wire the observer to a Node-side handler.
 *
 * `addInitScript` as well as an immediate `evaluate`: the init script covers
 * the reloads Meet performs during a join, the evaluate covers the page that is
 * already open. Installing twice is harmless — the script's first line makes it
 * idempotent.
 */
export async function installCaptionObserver(context, page, onMessage, { settleMs } = {}) {
  try {
    await context.exposeBinding("__astraCaption", (_source, payload) => {
      try {
        onMessage(JSON.parse(payload));
      } catch {
        // A malformed message is not worth failing a meeting over.
      }
    });
  } catch (error) {
    // Already exposed on this context (a second page, or a re-entry).
    if (!/already registered/i.test(error.message ?? "")) throw error;
  }

  // Config first, and as an init script too, so it is in place before the
  // observer runs on any page — including the reloads Meet performs on the way
  // into a call.
  const settle = `window.__astraCapConfig = { settleMs: ${Number(settleMs) || 2000} };`;
  await context.addInitScript(settle);
  await page.evaluate(settle).catch(() => {});

  await context.addInitScript(CAPTION_OBSERVER_JS);
  return page.evaluate(CAPTION_OBSERVER_JS);
}

/**
 * Write down what the observer can actually see.
 *
 * Selector rot is the failure mode this whole module lives with: Google rotates
 * its obfuscated class names without notice, and when it does the symptom is
 * either no captions at all or -- worse -- the wrong text arriving, which reads
 * as a transcription bug rather than a selector one. That is exactly how a
 * "Jump to bottom" button ended up in a transcript.
 *
 * Guessing replacement class names from outside the meeting is hopeless. This
 * dumps the real caption region to `data/debug/captions-<ts>.json` so the next
 * fix is a five-minute read of the DOM instead of an afternoon of guessing.
 */
export async function dumpCaptionDiagnostics(page, log, { dir }) {
  let diag;
  try {
    diag = await page.evaluate("window.__astraCapDiag && window.__astraCapDiag()");
  } catch (error) {
    log.warn(`could not read caption diagnostics: ${error.message}`);
    return null;
  }
  if (!diag) {
    log.warn("the caption observer is not installed on this page");
    return null;
  }

  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const target = path.join(dir, "debug");
  await mkdir(target, { recursive: true });
  const file = path.join(target, `captions-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(diag, null, 2), "utf8");

  // The summary answers the three questions worth asking, without opening it.
  log.warn(
    `caption diagnostics: root=${diag.rootFound ? diag.rootTag + "." + (diag.rootClass || "?") : "NOT FOUND"} ` +
      `· matched=[${diag.rootSelectorsMatched.join(", ") || "none"}] ` +
      `· textSelectorHits=${JSON.stringify(diag.textSelectorHits)} ` +
      `· candidates=${diag.candidates.length}`,
  );
  for (const c of diag.candidates.slice(0, 5)) {
    log.warn(`  candidate ${c.tag}.${c.cls || "-"} jsname=${c.jsname ?? "-"} » ${c.text}`);
  }
  log.warn(`full DOM written to ${file}`);
  return { file, diag };
}

/** Finalise every pending block. Called once, on the way out of the call. */
export async function flushCaptions(page) {
  try {
    await page.evaluate("window.__astraFlush && window.__astraFlush()");
  } catch {
    // The page is already gone; there is nothing left to flush.
  }
}
