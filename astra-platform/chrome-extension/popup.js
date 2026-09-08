import { CONFIG, configured } from "./config.js";
import { signInWithPassword, fetchLedTeams } from "./lib/supabase.js";
import { clearSession, getValidSession, saveSession } from "./lib/session.js";
import { fetchBotCredentials, fetchPreContext, summonBot } from "./lib/api.js";

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
    await prefetch(state.teamId);
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
    const result = await summonBot(state.session.access_token, {
      team_id: state.teamId,
      meet_link: state.meetLink,
      pre_context: state.preContext,
      bot_credentials: state.credentials,
    });

    el("mainOk").textContent = result.message ?? "Bot summoned.";
    el("mainOk").hidden = false;
    el("connect").textContent = "Sent ✓";
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
  await clearSession();
  state.session = null;
  state.credentials = null;
  state.preContext = null;
  el("who").textContent = "";
  el("signOut").hidden = true;
  show("authPane");
});

el("team").addEventListener("change", async (event) => {
  state.teamId = event.target.value;
  setError("mainError", null);
  setError("mainOk", null);
  el("connect").textContent = "Connect Bot";
  await prefetch(state.teamId);
});

el("connect").addEventListener("click", connect);

boot().catch((error) => {
  setError("authError", error.message);
  show("authPane");
});
