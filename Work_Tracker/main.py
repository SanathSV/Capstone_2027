"""
Focus / Alignment Session Tracker  (Windows)  --  LLM-assisted edition
======================================================================
A local, transparent tool that measures whether a work session's ACTIVE
WINDOW / WEBSITE activity is aligned with an assigned task, using a
locally-run Ollama model to judge relevance semantically (not just by
keyword).

PRIVACY & TRANSPARENCY BY DESIGN
  - Captures only metadata: timestamp, foreground process name,
    foreground window title, and (for browsers) the site DOMAIN only.
  - Never captures: keystrokes, screenshots, clipboard, mouse movement,
    file contents, browser history, or full URLs (no paths, no query
    strings, no search terms).
  - The Ollama model runs on THIS machine (http://localhost:11434).
    Activity data is sent only to that local process -- never to any
    cloud service. Everything is stored locally as CSV.
  - The app runs in a visible window with explicit Start/Stop. It is not
    covert. A notification acknowledgment is required before a session
    starts, because monitoring a worker's screen generally requires the
    worker to be informed/consent (rules vary by jurisdiction).

INSTALL (one time):
    Windows: pip install pywin32 psutil matplotlib uiautomation
    macOS:   pip install psutil matplotlib pyobjc-framework-Cocoa pyobjc-framework-Quartz
    macOS also requires a Python distribution with Tk support for the GUI.
    # Ollama:  install from https://ollama.com , then:
    #   ollama serve
    #   ollama pull llama3.2        (or any small instruct model)

RUN:
    python session_tracker.py
"""

import csv
import json
import time
import queue
import threading
import datetime
import os
import platform
import subprocess
import urllib.request
import urllib.error
from urllib.parse import urlparse

import psutil

if platform.system() == "Windows":
    import win32gui
    import win32process
else:
    import Quartz

try:
    if platform.system() == "Windows":
        import uiautomation as auto
        UIAUTOMATION_OK = True
    else:
        UIAUTOMATION_OK = False
except Exception:
    UIAUTOMATION_OK = False

import tkinter as tk
from tkinter import ttk, messagebox

# ----------------------------- Config --------------------------------
POLL_INTERVAL_SEC = 5
OLLAMA_URL = "http://localhost:11434/api/generate"
DEFAULT_MODEL = "llama3.2"
LLM_TIMEOUT_SEC = 25

LOG_DIR = os.path.join(os.path.expanduser("~"), "focus_tracker_logs")
os.makedirs(LOG_DIR, exist_ok=True)

BROWSER_PROCS = {
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe",
    "Google Chrome", "Microsoft Edge", "Firefox", "Brave Browser",
    "Safari",
}
ADDR_BAR_NAMES = ["Address and search bar", "Search or enter address",
                  "Address bar", "Search or enter web address"]

STATUSES = ("on_track", "drifting", "unclear")


# ------------------------ Activity capture ---------------------------
def get_active_window_info():
    """(process_name, window_title, hwnd) for the foreground window.
    Only metadata is read; no window content is captured."""
    try:
        if platform.system() == "Windows":
            hwnd = win32gui.GetForegroundWindow()
            title = win32gui.GetWindowText(hwnd) or "(no title)"
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            proc_name = psutil.Process(pid).name()
            return proc_name, title, hwnd

        windows = Quartz.CGWindowListCopyWindowInfo(
            Quartz.kCGWindowListOptionOnScreenOnly
            | Quartz.kCGWindowListExcludeDesktopElements,
            Quartz.kCGNullWindowID,
        ) or []
        for window in windows:
            if window.get(Quartz.kCGWindowLayer, 1) != 0:
                continue
            pid = window.get(Quartz.kCGWindowOwnerPID)
            if not pid:
                continue
            proc_name = window.get(Quartz.kCGWindowOwnerName, "unknown")
            title = window.get(Quartz.kCGWindowName) or "(no title)"
            return proc_name, title, window.get(Quartz.kCGWindowNumber)
    except Exception:
        pass
    return "unknown", "unknown", None


def _mac_browser_url(app_name):
    """Read the active browser URL through macOS automation."""
    scripts = {
        "Safari": 'tell application "Safari" to get URL of front document',
        "Google Chrome": 'tell application "Google Chrome" to get URL of active tab of front window',
        "Microsoft Edge": 'tell application "Microsoft Edge" to get URL of active tab of front window',
        "Brave Browser": 'tell application "Brave Browser" to get URL of active tab of front window',
        "Firefox": 'tell application "Firefox" to get URL of active tab of front window',
    }
    script = scripts.get(app_name)
    if not script:
        return ""
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def get_browser_domain(proc_name, hwnd):
    """For a known browser, read ONLY the domain from the address bar
    (e.g. 'github.com'). No path/query/search terms are captured.
    Returns '' when not a browser or address bar unreadable."""
    if hwnd is None:
        return ""

    if platform.system() != "Windows":
        raw = _mac_browser_url(proc_name)
        if not raw:
            return ""
        if "://" not in raw:
            raw = "http://" + raw
        domain = urlparse(raw).netloc.lower()
        return domain[4:] if domain.startswith("www.") else domain

    if not UIAUTOMATION_OK or proc_name.lower() not in BROWSER_PROCS:
        return ""
    try:
        top = auto.ControlFromHandle(hwnd)
        edit = None
        for name in ADDR_BAR_NAMES:
            candidate = top.EditControl(Name=name, searchDepth=15)
            if candidate.Exists(0, 0):
                edit = candidate
                break
        if edit is None:
            return ""
        vp = edit.GetValuePattern()
        raw = vp.Value if vp else ""
        if not raw:
            return ""
        if "://" not in raw:
            raw = "http://" + raw
        domain = urlparse(raw).netloc.lower()
        return domain[4:] if domain.startswith("www.") else domain
    except Exception:
        return ""


# --------------------------- Classifier ------------------------------
def keyword_hit(proc, title, domain, keywords):
    hay = f"{proc} {title} {domain}".lower()
    return any(kw.strip() and kw.strip().lower() in hay for kw in keywords)


def ollama_classify(task, proc, title, domain, model):
    """Ask the local Ollama model to judge alignment.
    Returns (status, reason). On any failure returns (None, None)."""
    prompt = (
        "You are a workplace focus classifier. An employee has an assigned "
        "task. Given ONE snapshot of their current computer activity, decide "
        "whether it is aligned with that task.\n\n"
        f'Assigned task: "{task}"\n\n'
        "Current activity:\n"
        f"- Application: {proc}\n"
        f"- Window title: {title}\n"
        f"- Website domain: {domain or '(not a browser / unknown)'}\n\n"
        'Respond ONLY with JSON: '
        '{"status":"on_track|drifting|unclear","reason":"<max 12 words>"}\n'
        "Guidance: documentation, code hosts, relevant tools, and research "
        "clearly related to the task are on_track. Entertainment, social "
        "media, shopping, or unrelated topics are drifting. If the snapshot "
        "is not enough to tell, use unclear."
    )
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
    }
    try:
        req = urllib.request.Request(
            OLLAMA_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT_SEC) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        inner = json.loads(body.get("response", "{}"))
        status = str(inner.get("status", "")).strip().lower()
        reason = str(inner.get("reason", "")).strip()[:80]
        if status not in STATUSES:
            status = "unclear"
        return status, (reason or "no reason given")
    except Exception as e:
        return None, None


def signature_of(proc, title, domain):
    """Cache key: browsers keyed by domain; apps keyed by title.
    Repeated identical activity is classified once, then reused."""
    if domain:
        return ("web", domain)
    return ("app", proc.lower(), title.lower())


# ----------------------------- App -----------------------------------
class TrackerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Focus Alignment Tracker (local LLM)")
        self.root.geometry("560x520")

        self.running = False
        self.poll_thread = None
        self.worker_thread = None

        self.lock = threading.Lock()
        self.log_rows = []            # list of dict rows
        self.cache = {}               # signature -> (status, reason)
        self.inflight = set()         # signatures queued/being classified
        self.work_q = queue.Queue()

        pad = {"padx": 10, "pady": 4}

        tk.Label(root, text="Assigned task (plain English):").pack(anchor="w", **pad)
        self.task_entry = tk.Text(root, width=64, height=3)
        self.task_entry.pack(**pad)
        self.task_entry.insert("1.0",
                               "e.g. Implement the login flow in the myrepo backend "
                               "(auth module, JWT handling).")

        tk.Label(root, text="Optional fast-path keywords (comma separated, "
                            "instant on-track):").pack(anchor="w", **pad)
        self.kw_entry = tk.Entry(root, width=64)
        self.kw_entry.pack(**pad)
        self.kw_entry.insert(
            0,
            "myrepo, github.com, VS Code, Terminal, iTerm, PyCharm, Xcode, "
            "Safari, Google Chrome, documentation, Stack Overflow, Jira, "
            "Confluence, Slack, Zoom, Google Drive, localhost"
        )

        row = tk.Frame(root); row.pack(fill="x", **pad)
        tk.Label(row, text="Ollama model:").pack(side="left")
        self.model_entry = tk.Entry(row, width=22)
        self.model_entry.pack(side="left", padx=6)
        self.model_entry.insert(0, DEFAULT_MODEL)

        # Consent / transparency gate
        self.consent = tk.BooleanVar(value=False)
        tk.Checkbutton(
            root, variable=self.consent, wraplength=520, justify="left",
            text=("The person being monitored has been informed that this "
                  "session records active application, window title, and "
                  "website domain, and consents where required by law."),
        ).pack(anchor="w", **pad)

        btns = tk.Frame(root); btns.pack(**pad)
        self.start_btn = tk.Button(btns, text="Start Session", width=16,
                                   bg="#2e7d32", fg="white", command=self.start_session)
        self.start_btn.grid(row=0, column=0, padx=5)
        self.stop_btn = tk.Button(btns, text="Stop Session", width=16,
                                  bg="#c62828", fg="white", state="disabled",
                                  command=self.stop_session)
        self.stop_btn.grid(row=0, column=1, padx=5)

        self.status_var = tk.StringVar(value="Idle. Fill task, tick consent, start.")
        tk.Label(root, textvariable=self.status_var, fg="#555").pack(**pad)
        self.live_var = tk.StringVar(value="")
        tk.Label(root, textvariable=self.live_var,
                 font=("Segoe UI", 10, "bold")).pack(**pad)

        tk.Label(root, text=f"Logs: {LOG_DIR}", fg="#888").pack(anchor="w", **pad)

    # -- session control --
    def start_session(self):
        task = self.task_entry.get("1.0", "end").strip()
        if not task or task.startswith("e.g."):
            messagebox.showwarning("Task needed", "Describe the assigned task.")
            return
        if not self.consent.get():
            messagebox.showwarning("Consent required",
                                   "Confirm the person has been informed before starting.")
            return
        self.task = task
        self.model = self.model_entry.get().strip() or DEFAULT_MODEL
        kw = self.kw_entry.get().strip()
        self.keywords = [k for k in kw.split(",") if k.strip()] if kw else []

        with self.lock:
            self.log_rows = []
            self.cache = {}
            self.inflight = set()
        self.session_start = datetime.datetime.now()
        self.running = True
        self.start_btn.config(state="disabled")
        self.stop_btn.config(state="normal")
        self.status_var.set("Session running. Active-window metadata only.")

        self.poll_thread = threading.Thread(target=self._poll_loop, daemon=True)
        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.poll_thread.start()
        self.worker_thread.start()

    def stop_session(self):
        self.running = False
        self.start_btn.config(state="normal")
        self.stop_btn.config(state="disabled")
        self.status_var.set("Session stopped. Finishing pending classifications...")
        # give worker a moment to drain the queue
        self.root.after(1500, self._finalize)

    def _finalize(self):
        self._save_log()
        self._show_summary()
        self.status_var.set("Done. Log saved.")

    # -- polling (fast, never blocks on the LLM) --
    def _poll_loop(self):
        while self.running:
            proc, title, hwnd = get_active_window_info()
            domain = get_browser_domain(proc, hwnd)
            ts = datetime.datetime.now()

            if self.keywords and keyword_hit(proc, title, domain, self.keywords):
                status, reason = "on_track", "keyword match"
            else:
                sig = signature_of(proc, title, domain)
                with self.lock:
                    cached = self.cache.get(sig)
                if cached:
                    status, reason = cached
                else:
                    status, reason = "pending", ""
                    with self.lock:
                        if sig not in self.inflight:
                            self.inflight.add(sig)
                            self.work_q.put((sig, proc, title, domain))

            row = {"ts": ts, "proc": proc, "title": title,
                   "domain": domain, "status": status, "reason": reason}
            with self.lock:
                self.log_rows.append(row)

            tag = f" | {domain}" if domain else ""
            self.live_var.set(f"[{ts.strftime('%H:%M:%S')}] {proc}{tag} | {status.upper()}")
            time.sleep(POLL_INTERVAL_SEC)

    # -- background classifier worker --
    def _worker_loop(self):
        while self.running or not self.work_q.empty():
            try:
                sig, proc, title, domain = self.work_q.get(timeout=1)
            except queue.Empty:
                continue
            status, reason = ollama_classify(self.task, proc, title, domain, self.model)
            if status is None:
                # LLM unavailable: don't guess drifting. Mark unclear once.
                status, reason = "unclear", "LLM unavailable"
            with self.lock:
                self.cache[sig] = (status, reason)
                self.inflight.discard(sig)
                for r in self.log_rows:
                    if r["status"] == "pending" and \
                       signature_of(r["proc"], r["title"], r["domain"]) == sig:
                        r["status"], r["reason"] = status, reason
            self.work_q.task_done()

    # -- outputs --
    def _save_log(self):
        with self.lock:
            rows = list(self.log_rows)
        if not rows:
            return
        fname = f"session_{self.session_start.strftime('%Y%m%d_%H%M%S')}.csv"
        self.last_log_path = os.path.join(LOG_DIR, fname)
        with open(self.last_log_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["timestamp", "process", "window_title", "domain",
                        "status", "reason"])
            for r in rows:
                w.writerow([r["ts"].isoformat(), r["proc"], r["title"],
                            r["domain"], r["status"], r["reason"]])

    def _show_summary(self):
        with self.lock:
            rows = list(self.log_rows)
        if not rows:
            messagebox.showinfo("No data", "No activity recorded.")
            return

        total = len(rows)
        counts = {s: sum(1 for r in rows if r["status"] == s) for s in STATUSES}
        counts["pending"] = sum(1 for r in rows if r["status"] == "pending")
        mins = lambda n: n * POLL_INTERVAL_SEC // 60
        pct = lambda n: round(100 * n / total, 1)

        win = tk.Toplevel(self.root)
        win.title("Session Summary")
        win.geometry("640x560")

        tk.Label(win, text=f"On track: {pct(counts['on_track'])}%  "
                           f"({mins(counts['on_track'])} min)",
                 font=("Segoe UI", 12, "bold"), fg="#2e7d32").pack(pady=6)
        tk.Label(win, text=f"Drifting: {pct(counts['drifting'])}%  "
                           f"({mins(counts['drifting'])} min)   |   "
                           f"Unclear: {pct(counts['unclear'])}%",
                 font=("Segoe UI", 11), fg="#c62828").pack()
        tk.Label(win, text=f"Log saved: {self.last_log_path}", fg="#888",
                 wraplength=600, justify="left").pack(pady=4)

        cols = ("Time", "Process", "Title", "Domain", "Status", "Reason")
        widths = (70, 90, 150, 110, 70, 150)
        tree = ttk.Treeview(win, columns=cols, show="headings", height=16)
        for c, w_ in zip(cols, widths):
            tree.heading(c, text=c)
            tree.column(c, width=w_)
        for r in rows:
            tree.insert("", "end", values=(
                r["ts"].strftime("%H:%M:%S"), r["proc"], r["title"][:35],
                r["domain"], r["status"], r["reason"][:40]))
        tree.pack(fill="both", expand=True, padx=10, pady=6)

        try:
            import matplotlib.pyplot as plt
            labels = ["On track", "Drifting", "Unclear"]
            vals = [counts["on_track"], counts["drifting"], counts["unclear"]]
            colors = ["#2e7d32", "#c62828", "#9e9e9e"]
            keep = [(l, v, c) for l, v, c in zip(labels, vals, colors) if v > 0]
            if keep:
                plt.figure(figsize=(4.2, 4.2))
                plt.pie([v for _, v, _ in keep],
                        labels=[l for l, _, _ in keep],
                        colors=[c for _, _, c in keep], autopct="%1.1f%%")
                plt.title("Session Alignment")
                plt.tight_layout(); plt.show()
        except Exception:
            pass


if __name__ == "__main__":
    root = tk.Tk()
    TrackerApp(root)
    root.mainloop()

