.venv/bin/activate


arch and formula for drift score
Your system takes this theoretical research and operationalizes it into software. Instead of relying on manual surveys or naive line-of-code counting, your code executes this exact math locally on the desktop to translate raw window events into a privacy-first score.

---

### End-to-End Pipeline in Your Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ON-DEVICE CLIENT (agent.py)                                                            │
│                                                                                        │
│  [ Active Window & Browser Metadata Hook ] ──► Every 5s Poll                           │
│                     │                                                                  │
│                     ▼                                                                  │
│  [ Local Ollama / Keyword Classifier ]      ──► Assigns Weight (1.0 / 0.6 / 0.0)      │
│                     │                                                                  │
│                     ▼                                                                  │
│  [ SQLite Cache (local_tracker.db) ]         ──► Stores Snapshots                      │
│                     │                                                                  │
│                     ▼ (User Clicks "Sync/Submit" or Simulation Finishes)              │
│  [ drift_engine.py Engine Execution ]                                                 │
│     ├── Filter Idle Snapshots (Idle > 180s) ──► Compute Sa                             │
│     ├── Track Work->Drift Transitions      ──► Apply Exponential Decay Penalty (Sf)   │
│     └── Read Git Logs                       ──► Apply Outcome Multiplier (Sd)          │
└─────────────────────────────────┬──────────────────────────────────────────────────────┘
                                  │
                                  ▼ (Anonymized JSON Payload)
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ CENTRAL SERVER & DASHBOARD (server.py + backend_dashboard.db)                          │
│                                                                                        │
│  [ FastAPI / Flask Server ] ──► Saves Aggregated CDI Metrics                           │
│  [ Employer Web Portal ]   ──► Displays True Focus % (Without Employee Surveillance)   │
└────────────────────────────────────────────────────────────────────────────────────────┘

```

---

### Step-by-Step Mathematical Execution

#### 1. Semantic Alignment ($S_A$) Execution

Every 5 seconds, `agent.py` polls the active OS foreground window. It checks if the activity matches the active task using keyword matching or a local Ollama LLM call, returning `on_track`, `support_tool`, or `drifting`.

In `drift_engine.py`, these snapshots are converted into numerical weights:

* **`on_track`** = $1.0$ (VS Code, terminal running the repo)
* **`support_tool`** = $0.6$ (StackOverflow, Jira, technical documentation)
* **`drifting`** = $0.0$ (YouTube Shorts, Reddit, non-work streams)

Idle samples (where system activity is absent for $\ge 180\text{s}$) are pruned out completely so a developer stepping away for lunch isn't penalized for slacking.

$$S_A = \frac{\text{Sum of Active Sample Weights}}{\text{Total Non-Idle Samples}}$$

#### 2. Flow Continuity Penalty ($S_F$) Execution

`drift_engine.py` iterates sequentially through your snapshot history. Whenever it detects a status transition from productive work (`on_track` or `support_tool`) directly into `drifting`, it increments the context-switch counter ($N_{\text{switches}}$).

Because switching to a distraction disrupts the developer's focus recovery window, $S_F$ uses an exponential decay curve rather than a linear deduction:

$$S_F = \exp(-0.05 \cdot N_{\text{switches}})$$

* **0 Switches:** $S_F = 1.00$ ($100\%$ flow retained)
* **5 Switches:** $S_F = 0.77$ ($77\%$ flow retained)
* **30 Switches:** $S_F = 0.22$ ($22\%$ flow retained—heavily penalizing erratic context switching)

#### 3. Artifact Delivery Multiplier ($S_D$) Execution

To prevent developers from gaming the system by leaving VS Code open while idle or scrolling code without delivering, `agent.py` executes `git log --since=24.hours`.

`drift_engine.py` adjusts the multiplier based on these outputs:

* **$1.20\times$ Bonus:** Verified Git commits or significant code churn ($>20$ lines added/deleted) are detected in the session.


* **$0.85\times$ Penalty:** High focus time is logged ($>12$ active samples) with **zero** Git commits or line changes.


* **$1.00\times$ Neutral:** Baseline for short sessions.



---

### What Your Simulation Output Verified

When you ran `simulate_session.py`, here is how your engine calculated the final score:

```text
  Semantic Alignment (Sa) : 73.08%   (Derived from 156 active snapshots)
  Flow Continuity (Sf)    : 22.31%   (Penalized due to 30 context switches)
  Git Artifacts           : 1.2x     (1 Verified Commit with +120/-15 churn)
--------------------------------------------------
  FINAL COMPOSITE DRIFT INDEX (CDI) : 69.42%

```

Using your engine's formula weights ($\alpha = 0.7$, $\beta = 0.3$):

$$\text{Base Score} = (0.7 \times 0.7308) + (0.3 \times 0.2231) = 0.51156 + 0.06693 = 0.57849$$

$$\text{Final CDI} = \min\left(100, 0.57849 \times 1.2 \times 100\right) = \mathbf{69.42\%}$$

### Why This Architecture Works

1. **Un-gameable:** A developer cannot leave an IDE open without committing ($S_D$ penalty kicks in) or rapidly switch between YouTube and VS Code ($S_F$ penalty drops the score).
2. **Privacy-Preserving:** Raw window titles and code stay on the local machine. Only the sanitized composite summary ($\text{CDI} = 69.42\%$) is submitted to `server.py` and rendered on `dashboard.html`.