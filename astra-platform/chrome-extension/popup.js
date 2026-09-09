import { CONFIG, configured } from "./config.js";
import { signInWithPassword, fetchLedTeams } from "./lib/supabase.js";
import { clearSession, getValidSession, saveSession } from "./lib/session.js";
import {
  dispatchBot,
  fetchBotCredentials,
  fetchContainerHealth,
  fetchLiveSession,
  fetchPreContext,
  fetchSession,
  stopBot,
} from "./lib/api.js";

/**
 * The popup.
 *
 * Three panes, one visible at a time: not configured, signed out, or ready.
 *
 * The shape of the flow is set by one fact — **Connect Bot must be instant**.
 * By the time a leader opens this, the meeting has started and people are
 * waiting. So both payloads are fetched the moment a team is picked, and the
 * button stays disabled until they are actually in hand. Pressing it then is
 * one POST of data already sitting in memory, rather than the start of a
 * multi-second round trip while a call goes on without its notetaker.
 */

const el = (id) => document.getElementById(id);
const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;

/**
 * Everything fetched ahead of the click.
 *
 * `credentials` is a live Google session. It lives here, in the popup's memory,
 * and is gone the moment the popup closes — deliberately never written to
 * chrome.storage, where it would outlive the click that needed it.
 */
const state = {
  session: null,
  teams: [],
  teamId: "",
  meetLink: null,
  preContext: null,
  credentials: null,
  /** Bumped on every team change so a slow response cannot overwrite a newer one. */
  fetchToken: 0,

  /**
   * The bot currently in this room, as the container describes it — or null.
   *
   * This is re-derived from the container on every popup open rather than
   * remembered, because a popup's memory dies with the popup and a session id
   * cached in chrome.storage would be wrong the moment the bot left.
   */
  live: null,
  pollTimer: null,

  /** The container's own health, so "no bot" and "no service" look different. */
  host: null,
};

// --------------------------------------------------------------------------
// Panes
// --------------------------------------------------------------------------

function show(pane) {
  for (const id of ["unconfigured", "authPane", "mainPane"]) {
    el(id).hidden = id !== pane;
  }
}

function setError(id, message) {
  const node = el(id);
  node.textContent = message ?? "";
  node.hidden = !message;
}

function setCheck(id, state, detail) {
  const node = el(id);
  node.className = `check ${state}`;
  node.querySelector(".check-detail").textContent = detail;
}

// --------------------------------------------------------------------------
// The active tab
// --------------------------------------------------------------------------

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? "";

  if (MEET_URL.test(url)) {
    // Strip query strings: Meet appends things like ?authuser=1, and the bot
    // only needs the room.
    state.meetLink = url.split("?")[0];
    el("meetState").textContent = "Google Meet";
    el("meetState").className = "pill ok";
    el("meetLink").textContent = state.meetLink;
  } else {
    state.meetLink = null;
    el("meetState").textContent = "not a Meet tab";
    el("meetState").className = "pill bad";
    el("meetLink").textContent =
      url ? "Open the Google Meet you want the bot in, then click Astra again." : "";
  }
}

// --------------------------------------------------------------------------
// Prefetch
// --------------------------------------------------------------------------

/**
 * Fetches the two payloads for a team, in parallel.
 *
 * They fail independently and report separately, because they fail for
 * completely different reasons — a missing pre-context means "go press Generate
 * Pre-Context", a missing credential means "go authenticate the bot" — and a
 * single combined error would send people to the wrong page.
 */
async function prefetch(teamId) {
  // A bot is already in the room, so there is nothing to summon and nothing to
  // prepare. Skipping this is not just tidiness: it stops the readiness checks
  // reappearing underneath the live panel on reopen, and it avoids pulling a
  // live Google session into the popup for a click that cannot happen.
  if (state.live) {
    el("readiness").hidden = true;
    return;
  }

  const token = ++state.fetchToken;
  state.preContext = null;
  state.credentials = null;

  if (!teamId) {
    el("readiness").hidden = true;
    updateButton();
    return;
  }

  el("readiness").hidden = false;
  // Two different waits, so two different words. Credentials are a file read
  // and return instantly; pre-context may have to go and ask GitHub and Jira,
  // which takes seconds — saying "fetching" for both would make the slow one
  // look stuck.
  setCheck("checkContext", "pending", "harvesting…");
  setCheck("checkCreds", "pending", "reading…");
  updateButton();

  // A slow harvest is normal the first time a team is used, so the hint says
  // what is happening instead of leaving a disabled button unexplained.
  const slowNotice = setTimeout(() => {
    if (token === state.fetchToken && !state.preContext) {
      el("connectHint").textContent =
        "First run for this team — asking GitHub and Jira. This takes a few seconds.";
    }
  }, 1500);

  const [context, creds] = await Promise.allSettled([
    fetchPreContext(state.session.access_token, teamId),
    fetchBotCredentials(state.session.access_token),
  ]);
  clearTimeout(slowNotice);

  // A slower response for a team the user has already moved on from must not
  // land on top of the current one.
  if (token !== state.fetchToken) return;

  if (context.status === "fulfilled") {
    const result = context.value;
    state.preContext = result.payload;

    const age = result.age_seconds ?? 0;
    const when =
      result.source === "generated"
        ? "fresh"
        : age < 90
          ? "just now"
          : age < 5400
            ? `${Math.round(age / 60)}m ago`
            : `${Math.round(age / 3600)}h ago`;

    setCheck(
      "checkContext",
      result.stale ? "bad" : "ok",
      `${result.token_estimate ?? "?"} tokens · ${when}`,
    );
  } else {
    setCheck("checkContext", "bad", context.reason.message.slice(0, 90));
  }

  if (creds.status === "fulfilled") {
    state.credentials = creds.value;
    const auth = (creds.value.cookies ?? []).filter((c) =>
      String(c.domain ?? "").includes("google"),
    ).length;
    setCheck("checkCreds", "ok", `${creds.value.google_email ?? "signed in"} · ${auth} cookies`);
  } else {
    setCheck("checkCreds", "bad", creds.reason.message.slice(0, 90));
  }

  updateButton();
}

function updateButton() {
  // A bot is already in this room. Offering to summon another one is the one
  // thing this popup must never do, so live mode owns the controls outright
  // rather than competing with the readiness logic below.
  if (state.live) return;

  const ready =
    Boolean(state.meetLink) &&
    Boolean(state.teamId) &&
    Boolean(state.preContext) &&
    Boolean(state.credentials);

  el("connect").disabled = !ready;

  const missing = [];
  if (!state.meetLink) missing.push("a Google Meet tab");
  if (!state.teamId) missing.push("a team");
  if (state.teamId && !state.preContext) missing.push("pre-context");
  if (state.teamId && !state.credentials) missing.push("bot credentials");

  el("connectHint").textContent = ready
    ? "Sends the meet link, pre-context and bot session to Astra."
    : `Waiting on: ${missing.join(", ")}.`;
}

// --------------------------------------------------------------------------
// The container
// --------------------------------------------------------------------------

/**
 * Show whether BOT-CONTAINER is up, and what it says about itself.
 *
 * This gets its own line because the two failures it separates are
 * indistinguishable from the summon side and mean opposite things: "there is no
 * bot in this room" is the normal state, and "the bot service is not running" is
 * a Connect Bot that is guaranteed to fail. Without this, both look like an
 * enabled button.
 */
async function refreshHost() {
  const pill = el("hostState");
  try {
    const health = await fetchContainerHealth();
    state.host = health;

    const ok = health.status === "ok";
    pill.textContent = ok ? "Running" : "Degraded";
    pill.className = `pill ${ok ? "ok" : "bad"}`;

    const bits = [];
    const active = health.sessions?.active ?? 0;
    bits.push(active === 1 ? "1 meeting" : `${active} meetings`);
    if (health.gemini_model) bits.push(health.gemini_model);
    // The interesting half of "degraded" is always why, and it is always the
    // database — the container cannot record a transcript without it.
    if (!ok && health.supabase?.error) bits.push(health.supabase.error.slice(0, 60));
    el("hostDetail").textContent = bits.join(" · ");
  } catch (error) {
    state.host = null;
    pill.textContent = "Not running";
    pill.className = "pill bad";
    el("hostDetail").textContent = `${CONFIG.BOT_API_BASE} — ${error.message.slice(0, 80)}`;
  }
}

// --------------------------------------------------------------------------
// Live bot
// --------------------------------------------------------------------------

/**
 * The container's session statuses, in words a person in a meeting can act on.
 *
 * `working: true` drives a pulsing pill. That is not decoration: "Joining" and
 * "In the call" are one word apart in a small panel, and without motion a bot
 * stuck in the lobby looks exactly like one that got in.
 */
const LIVE_STATES = {
  queued: {
    label: "Starting", tone: "live-working",
    hint: "Preparing the browser.",
  },
  launching: {
    label: "Starting", tone: "live-working",
    hint: "Launching the browser.",
  },
  joining: {
    label: "Joining", tone: "live-working",
    hint: "Opening the meeting.",
  },
  waiting_admission: {
    label: "In the lobby", tone: "bad",
    hint: "Waiting to be let in \u2014 admit it from the Meet tab.",
  },
  in_call: {
    label: "In the call", tone: "ok",
    hint: 'Say "Hey Astra, ..." and it answers in the chat.',
  },
  leaving: {
    label: "Leaving", tone: "live-working",
    hint: "Saving the transcript and hanging up.",
  },
  ended: {
    label: "Left", tone: "",
    hint: "The bot has left this meeting.",
  },
  failed: {
    label: "Failed", tone: "bad",
    hint: "The bot could not stay in the meeting.",
  },
};

/** Enter live mode: the summon controls are replaced by the bot's status. */
function enterLive(session) {
  state.live = session;
  el("live").hidden = false;
  el("readiness").hidden = true;
  el("connect").hidden = true;
  el("remove").hidden = false;
  el("team").disabled = true;
  renderLive(session);
  startPolling();
}

/** Back to the summon controls, after the bot has left or failed. */
function exitLive() {
  stopPolling();
  state.live = null;
  el("live").hidden = true;
  el("connect").hidden = false;
  el("connect").textContent = "Connect Bot";
  el("remove").hidden = true;
  el("remove").disabled = false;
  el("remove").textContent = "Remove Bot";
  el("team").disabled = false;
  el("readiness").hidden = !state.teamId;
  updateButton();
}

function renderLive(session) {
  const look = LIVE_STATES[session.status] ?? { label: session.status, tone: "", hint: "" };

  const pill = el("liveState");
  pill.textContent = look.label;
  pill.className = `pill ${look.tone}`;

  // Which bot, in which meeting \— the two facts that tell you whether this is
  // the session you think it is.
  const bits = [];
  if (session.meeting?.number) bits.push(`Meeting #${session.meeting.number}`);
  if (session.team?.name) bits.push(session.team.name);
  if (session.google_account) bits.push(session.google_account);
  // A guest join is not a failure, but it is not the normal state either: the
  // bot had to be admitted by hand and shows up under a generic name. Saying so
  // stops it looking like an ordinary signed-in join.
  else if (session.joined_as === "guest") bits.push("joined as a guest");
  el("liveWhere").textContent = bits.join(" \u00b7 ");

  // The two things that need acting on rather than watching. Captions first:
  // without them the bot is in the room but deaf, which is the more urgent of
  // the two because it can still be fixed while the meeting is running.
  const problem =
    session.captions_enabled === false
      ? "Captions could not be turned on for the bot, so it cannot transcribe or " +
        "answer in this meeting. Meet's CC toggle is per-participant — nobody else " +
        "can enable it for it. Remove the bot and summon it again."
      : session.credential_warning;

  if (problem) {
    setError("mainError", problem);
    el("mainError").className = "note note-warn";
  }

  const counts = session.counts ?? {};
  el("liveStats").replaceChildren(
    ...[
      ["Lines", counts.finalLines ?? 0],
      ["Asked", counts.questions ?? 0],
      ["Answered", counts.answers ?? 0],
    ].map(([label, value]) => {
      // Built as nodes rather than an innerHTML string: these numbers come from
      // the network, and this popup is not the place to reintroduce an
      // injection point for the sake of three <div>s.
      const cell = document.createElement("div");
      cell.className = "stat";
      const v = document.createElement("span");
      v.className = "stat-value";
      v.textContent = String(value);
      const l = document.createElement("span");
      l.className = "stat-label";
      l.textContent = label;
      cell.append(v, l);
      return cell;
    }),
  );

  el("connectHint").textContent = session.error ? session.error.slice(0, 140) : look.hint;

  // A finished session is history, not a live bot: drop back to the summon
  // controls so the room can be re-joined.
  if (session.status === "ended" || session.status === "failed") {
    stopPolling();
    if (session.status === "failed") setError("mainError", session.error ?? "The bot failed.");
    // Held on screen for a moment so the outcome is readable rather than a flash.
    setTimeout(() => {
      if (state.live && ["ended", "failed"].includes(state.live.status)) exitLive();
    }, 4000);
  }
}

/**
 * Poll while the popup is open, and only while it is open.
 *
 * Two and a half seconds is chosen against what the user is actually waiting
 * for: the lobby. Being admitted is the one transition where somebody is
 * watching this panel, and a slower poll makes the extension feel broken at
 * exactly that moment. The container is local and the response is a few hundred
 * bytes, so the cost is nil.
 */
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.live) return stopPolling();
    try {
      const session = await fetchSession(state.live.session_id, {
        token: state.session?.access_token,
      });
      if (session) {
        state.live = session;
        renderLive(session);
      }
      await refreshHost();
    } catch {
      // A dropped poll is not worth an error message \— the container may be
      // restarting, and the next tick picks it up.
    }
  }, 2500);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/**
 * Is a bot already in this room?
 *
 * Asked on every popup open, because the popup's memory does not survive being
 * closed \— which is most of the time.
 */
async function refreshLive() {
  if (!state.meetLink) return;
  try {
    const session = await fetchLiveSession(state.meetLink, {
      token: state.session?.access_token,
    });
    if (session) enterLive(session);
  } catch {
    // The container being down is not an error here: it just means there is no
    // bot to show. Clicking Connect reports it properly.
  }
}

/**
 * Ask the bot to leave.
 *
 * Deliberately not a kill. The container flushes the caption buffer, drains the
 * transcript queue and writes the meeting summary on the way out, so the last
 * thing anybody said still reaches the database. That takes a moment, which is
 * why the button says "Leaving..." and the panel keeps polling rather than
 * declaring success immediately.
 */
async function removeBot() {
  if (!state.live) return;
  setError("mainError", null);
  setError("mainOk", null);
  el("remove").disabled = true;
  el("remove").textContent = "Leaving...";

  try {
    const session = await stopBot(state.live.session_id, {
      token: state.session?.access_token,
    });
    if (session) {
      state.live = session;
      renderLive(session);
    }
    startPolling(); // watch it through leaving -> ended
  } catch (error) {
    setError("mainError", error.message);
    el("remove").disabled = false;
    el("remove").textContent = "Remove Bot";
  }
}

// --------------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------------

async function loadTeams() {
  const select = el("team");
  try {
    state.teams = await fetchLedTeams(state.session.access_token, state.session.user.id);
  } catch (error) {
    setError("mainError", error.message);
    select.innerHTML = '<option value="">Could not load teams</option>';
    return;
  }

  if (state.teams.length === 0) {
    select.innerHTML = '<option value="">You do not lead any teams</option>';
    el("connectHint").textContent =
      "Create a team in Astra — the bot is summoned on behalf of a team you lead.";
    return;
  }

  select.innerHTML =
    '<option value="">Choose a team…</option>' +
    state.teams
      .map((team) => {
        const label = team.sprint_name ? `${team.name} — ${team.sprint_name}` : team.name;
        return `<option value="${team.id}">${escapeHtml(label)}</option>`;
      })
      .join("");

  // One team is not a choice; pick it and start prefetching immediately.
  if (state.teams.length === 1) {
    select.value = state.teams[0].id;
    state.teamId = state.teams[0].id;
    if (!state.live) await prefetch(state.teamId);
  }
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

async function connect() {
  setError("mainError", null);
  setError("mainOk", null);
  el("connect").disabled = true;
  el("connect").textContent = "Summoning…";

  try {
    // Straight to BOT-CONTAINER. The four fields are unchanged — the container
    // takes the same contract the dashboard endpoint did.
    // The team's own name and description travel with the id.
    //
    // The id alone is enough for the container to *look the team up*, but only
    // if that lookup succeeds — and it is one network call, against a database
    // that may be slow or unreachable at exactly the moment somebody is trying
    // to get a notetaker into a standup that has already started. Sending the
    // two human-readable fields alongside means the bot can name the team in
    // the meeting, and brief the model on what the team is for, even when the
    // lookup fails.
    const team = state.teams.find((t) => t.id === state.teamId);

    const result = await dispatchBot(
      {
        team_id: state.teamId,
        team_name: team?.name ?? null,
        team_description: team?.description ?? null,
        meet_link: state.meetLink,
        pre_context: state.preContext,
        bot_credentials: state.credentials,
      },
      { token: state.session.access_token },
    );

    // 202 means "on its way", not "in the room". Rather than say so in a
    // sentence and leave the user watching a static button, hand straight over
    // to the live panel — which then shows the join actually progressing, and
    // which is also what stops this button being pressed a second time.
    enterLive({
      session_id: result.session_id,
      status: "queued",
      meeting: result.meeting ?? null,
      team: result.team ?? null,
      counts: {},
      error: null,
      google_account: null,
    });
  } catch (error) {
    setError("mainError", error.message);
    el("connect").textContent = "Connect Bot";
    el("connect").disabled = false;
  }
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

async function boot() {
  if (!configured()) {
    show("unconfigured");
    return;
  }

  state.session = await getValidSession();

  if (!state.session) {
    show("authPane");
    return;
  }

  el("who").textContent = state.session.user.email ?? "";
  el("signOut").hidden = false;
  show("mainPane");

  await readActiveTab();
  await refreshHost();
  // Before anything else about summoning: is there already a bot in this room?
  // The popup is reopened far more often than a bot is summoned, so this is the
  // common path, not the exception.
  await refreshLive();
  await loadTeams();
  updateButton();
}

el("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("authError", null);
  el("signIn").disabled = true;
  el("signIn").textContent = "Signing in…";

  try {
    state.session = await saveSession(
      await signInWithPassword(el("email").value.trim(), el("password").value),
    );
    await boot();
  } catch (error) {
    setError("authError", error.message);
  } finally {
    el("signIn").disabled = false;
    el("signIn").textContent = "Sign in";
  }
});

el("signOut").addEventListener("click", async () => {
  // Stop polling before the session token goes: an in-flight poll with a
  // cleared session would fail noisily for no reason.
  stopPolling();
  await clearSession();
  state.session = null;
  state.credentials = null;
  state.preContext = null;
  el("who").textContent = "";
  el("signOut").hidden = true;
  show("authPane");
});

el("team").addEventListener("change", async (event) => {
  // The select is disabled in live mode, so this cannot fire then — but a team
  // change must never quietly re-point a bot that is already in a call.
  if (state.live) return;
  state.teamId = event.target.value;
  setError("mainError", null);
  setError("mainOk", null);
  el("connect").textContent = "Connect Bot";
  await prefetch(state.teamId);
});

el("connect").addEventListener("click", connect);
el("remove").addEventListener("click", removeBot);

// A popup is torn down without ceremony when it loses focus. Clearing the
// interval here is tidiness rather than necessity, but it also stops a final
// poll firing against a half-dismantled document.
window.addEventListener("unload", stopPolling);

boot().catch((error) => {
  setError("authError", error.message);
  show("authPane");
});
