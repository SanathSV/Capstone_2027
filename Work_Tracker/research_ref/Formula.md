Here is a clear breakdown of the Composite Drift Index (CDI), a privacy-first metric designed to measure developer task alignment and focus without intrusive surveillance. Instead of recording screen content, logging keystrokes, or tracking exact URLs, the CDI engine evaluates semantic intent, cognitive context switching, and verified output artifacts.

┌─────────────────────────────────────────────────────────────────────────┐
│ LOCAL DEVELOPER LAPTOP                                                  │
│                                                                         │
│  1. Rust Agent (cdi-agent)  ──► Polls active OS window titles every 5s  │
│  2. Local Categorization     ──► Maps titles & Jira keys (on_track)     │
│  3. Local Engine Math        ──► Calculates Sa, Sf, Sd & final CDI %    │
│  4. Local SQLite Cache       ──► Persists snapshots in local_tracker.db │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     │ 5. HTTP POST (Sanitized 1KB JSON)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ AWS CLOUD BACKEND                                                       │
│                                                                         │
│  [ AWS API Gateway ]  ──► Validates request & API keys                  │
│          │                                                              │
│          ▼                                                              │
│  [ AWS SQS FIFO Queue ] ──► Buffers incoming session traffic & drops    │
│          │                  duplicate retries automatically             │
│          ▼                                                              │
│  [ AWS Lambda Worker ]  ──► Batches messages, converts metrics,         │
│          │                  writes 30-day session logs & updates        │
│          │                  permanent daily summaries                   │
│          ▼                                                              │
│  [ DynamoDB (CDI_Main)] ──► Single-Table schema storing user metrics    │
│          ▲                                                              │
│          │                                                              │
│  [ Dashboard FastAPI ] ──► Serves high-speed team focus summaries       │
│                            to employer dashboard UI (dashboard.html)    │
└─────────────────────────────────────────────────────────────────────────┘

================================================================================
HOW CDI MEASURES PRODUCTIVITY
================================================================================

The CDI score ranges from 0.0% to 100.0% and combines three core components:

1. SEMANTIC ALIGNMENT SCORE (Sa) — What tools are being used?
   Calculates the weighted ratio of active, non-idle foreground window time spent 
   on task-aligned tools.
   
   * Inactivity Filter: Any period of 3 minutes or more with no user activity 
     is flagged as "idle" and removed completely from calculations so break 
     time does not artificially alter drift metrics.
   
   * App / Activity Weights:
     - 1.0 (On Track)     : Primary IDEs, project repositories, terminals.
     - 0.6 (Support Tool) : Stack Overflow, technical docs, Jira, Slack.
     - 0.3 (Unclear)      : Unrecognized applications or pending LLM responses.
     - 0.0 (Drifting)     : Social media, non-work streams, entertainment.

2. FLOW CONTINUITY SCORE (Sf) — How often is focus broken?
   Grounded in UC Irvine research showing that switching away from primary work 
   disrupts cognitive flow state and incurs an average 23-minute recovery window.
   
   * Penalizes transitions from productive states (On Track / Support) into 
     drifting states using an exponential decay function.
   
   * Cognitive Retained Flow Benchmarks:
     - 0 switches  --> 100.0% flow retained (Sf = 1.00)
     - 5 switches  -->  77.9% flow retained (Sf = 0.78)
     - 15 switches -->  47.2% flow retained (Sf = 0.47)
     - 30 switches -->  22.3% flow retained (Sf = 0.22)

3. ARTIFACT DELIVERY MULTIPLIER (Sd) — Is code actually being delivered?
   Grounded in Microsoft Research & GitHub's SPACE framework, anchoring activity 
   metrics to real outcomes to prevent idle "focus farming" or leaving IDEs open.
   
   * Inspects local Git logs (git log --since=24.hours):
     - 1.20x Bonus    : Verified Git commits or code churn (>20 lines) exist.
     - 0.85x Penalty  : Active for over 1 hour (>12 active samples) with 0 Git 
                        commits or code churn.
     - 1.00x Baseline : Default baseline for short or neutral sessions.

================================================================================
THE MATHEMATICAL FORMULA
================================================================================

   CDI = Min(100, (0.7 * Sa + 0.3 * Sf) * Sd * 100)

   - 70% weight is given to Semantic Task Alignment (Sa).
   - 30% weight is given to Flow Continuity (Sf).
   - The resulting base score is multiplied by Artifact Delivery (Sd) and capped 
     at 100%.

================================================================================
HOW IT EXECUTES IN SOFTWARE
================================================================================

* Step 1: Edge Sampling (agent.py)
  Every 5 seconds, a lightweight local daemon samples active OS window titles, 
  process names, and browser domains.

* Step 2: Local AI Preprocessing
  Uncached application titles are classified locally using an on-device LLM 
  (llama3.2 via Ollama). No raw screen data or window titles ever leave the 
  developer's local machine.

* Step 3: Local Engine Calculation (drift_engine.py)
  At session completion, the system prunes idle logs, counts state transitions, 
  parses local Git churn, and computes the composite CDI metric locally.

* Step 4: Backend Transmission (server.py)
  Only the calculated final CDI score, total active hours, and sanitized commit 
  statistics are sent to the central backend database via JSON for high-level 
  dashboard progress charts. Raw detailed logs stay private on the local machine.