/* Popup logic: read the active tab's Meet URL, hand it to the container,
   then poll that session's transcript incrementally while the popup is open. */

const $ = (id) => document.getElementById(id);
const DEFAULTS = { server: "http://localhost:8080", key: "", name: "Meeting Notetaker" };

let pollTimer = null;
let sessionId = null;
let since = 0;

/* Astra's live state: the point is to see it wake up the moment it hears you,
   not to find out only when an answer appears. */
function setAstra(a) {
  const dot = $("astra-dot");
  const label = $("astra-label");
  const detail = $("astra-detail");
  if (!a || !a.state) {
    dot.className = "dot";
    label.textContent = "Astra: not running";
    detail.style.display = "none";
    return;
  }
  dot.className = "dot" + (a.state === "listening" ? " awake"
                        : a.state === "thinking" ? " think" : "");
  const icon = a.state === "listening" ? "LISTENING"
             : a.state === "thinking" ? "THINKING" : "asleep";
  label.textContent = `Astra: ${icon}`;

  const bits = [];
  if (a.state === "listening") {
    bits.push(a.heard ? `hearing: "${a.heard}"`
                      : `woken by ${a.asker || "you"} - ask your question`);
  } else if (a.state === "thinking") {
    bits.push(`asking ${a.model}...`);
    if (a.heard) bits.push(`"${a.heard}"`);
  } else if (a.last_answer) {
    bits.push(`Q: ${a.last_question}`);
    bits.push(`A: ${a.last_answer}`);
  } else {
    bits.push("say \"Astra\" out loud to wake it");
  }
  if (a.answered) bits.push(`(${a.answered} answered)`);
  detail.textContent = bits.join("\n");
  detail.style.display = "block";
}

function setStatus(text, cls = "muted") {
  const box = $("status");
  box.textContent = text;
  box.className = "box " + cls;
}

async function settings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function api(path, { method = "GET", body = null } = {}) {
  const { server, key } = await settings();
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  const response = await fetch(server.replace(/\/$/, "") + path, {
    method, headers, body: body ? JSON.stringify(body) : null,
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function activeMeetUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  return /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(tab.url)
    ? tab.url.split("?")[0]
    : null;
}

async function refreshTranscript() {
  if (!sessionId) return;
  try {
    const data = await api(`/api/sessions/${sessionId}/transcript?since=${since}`);
    since = data.next;
    if (data.lines.length) {
      const box = $("transcript");
      box.style.display = "block";
      for (const line of data.lines) {
        // The API keeps `text` clean and flags continuations separately; the
        // "..." marker is added here so a split sentence reads as one thought.
        const marker = line.continuation ? "..." : "";
        box.textContent += `${line.speaker}: ${marker}${line.text}\n`;
      }
      box.scrollTop = box.scrollHeight;
    }
    // Show the live stage ("Launching Chrome...", "In the call.") rather than
    // just a coarse state, so a slow join looks like progress, not a hang.
    setAstra(data.assistant);
    const stage = data.stage_message || data.state;
    setStatus(`${stage}\n${data.line_count} line(s) captured`,
              data.state === "failed" ? "err" : "ok");
    if (data.state === "ended" || data.state === "failed") {
      clearInterval(pollTimer);
      pollTimer = null;
      $("leave").style.display = "none";
      if (data.error) setStatus(`${data.state}: ${data.error}`, "err");
    }
  } catch (err) {
    setStatus(err.message, "err");
  }
}

function startPolling(id) {
  sessionId = id;
  since = 0;
  setAstra(null);
  $("leave").style.display = "block";
  chrome.storage.local.set({ lastSession: id });
  if (pollTimer) clearInterval(pollTimer);
  refreshTranscript();
  pollTimer = setInterval(refreshTranscript, 2000);
}

$("send").addEventListener("click", async () => {
  const url = await activeMeetUrl();
  if (!url) {
    setStatus("This tab is not a Google Meet call. Open the meeting first.", "err");
    return;
  }
  const { name } = await settings();
  $("send").disabled = true;
  setStatus("Sending the bot in…");
  try {
    const session = await api("/api/join", { method: "POST", body: { url, name } });
    setStatus(`Session ${session.session_id.slice(0, 8)} starting...`, "ok");
    startPolling(session.session_id);
  } catch (err) {
    setStatus(err.message, "err");
  } finally {
    $("send").disabled = false;
  }
});

$("leave").addEventListener("click", async () => {
  if (!sessionId) return;
  try {
    await api(`/api/sessions/${sessionId}/leave`, { method: "POST" });
    setStatus("Asked the bot to leave…");
  } catch (err) {
    setStatus(err.message, "err");
  }
});

/* Persist the three settings as they are typed. */
for (const field of ["server", "key", "name"]) {
  $(field).addEventListener("change", () =>
    chrome.storage.sync.set({ [field]: $(field).value.trim() }));
}

(async function init() {
  const config = await settings();
  $("server").value = config.server;
  $("key").value = config.key;
  $("name").value = config.name;

  const url = await activeMeetUrl();
  try {
    const health = await api("/api/health");
    // /api/health needs no key, so a missing key can be reported precisely
    // instead of letting the next call fail with a bare "unauthorized".
    if (health.auth_required && !config.key) {
      setStatus("This server needs an API key. Paste it in the API key box "
                + "above.\nGet it with:  docker inspect meet-listener "
                + "--format '{{range .Config.Env}}{{println .}}{{end}}' "
                + "| findstr MEET_API_KEY", "err");
      $("key").focus();
      return;
    }
    if (!health.credentials_present) {
      setStatus("Server is up, but the mounted profile has no Google login. "
                + "Bots will have to join as guests.", "err");
    } else if (!url) {
      setStatus("Server ready. Open a Google Meet tab to send the bot in.");
    } else {
      setStatus(`Server ready. ${health.active_sessions}/${health.max_sessions} `
                + `session(s) running.`, "ok");
    }
  } catch (err) {
    setStatus(`Cannot reach the server: ${err.message}`, "err");
    return;
  }

  /* Re-attach to the session this popup started last time, if it still exists. */
  const { lastSession } = await chrome.storage.local.get({ lastSession: null });
  if (lastSession) {
    try {
      const session = await api(`/api/sessions/${lastSession}`);
      if (["starting", "joining", "listening"].includes(session.state)) {
        startPolling(lastSession);
      }
    } catch { /* the session is gone; nothing to re-attach to */ }
  }
})();
