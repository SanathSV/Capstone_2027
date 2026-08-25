SUBJECT: Architecture & Formula Breakdown: Composite Drift Index (CDI) Engine

Here is the complete operational and mathematical breakdown of the Composite Drift Index (CDI) Engine, detailing how on-device activity tracking translates into privacy-preserving focus metrics.

# ================================================================================
END-TO-END SYSTEM ARCHITECTURE

1. ON-DEVICE CLIENT (agent.py)
* Samples OS active window and browser metadata every 5 seconds.
* Classifies window states via local keyword matching or local Ollama LLM.
* Assigns snapshot weights: 1.0 (On Track), 0.6 (Support Tool), 0.0 (Drifting).
* Persists snapshot data into a local SQLite cache (local_tracker.db).


2. LOCAL DRIFT ENGINE (drift_engine.py)
* Triggered manually via "Sync/Submit" or automatically upon session end.
* Prunes idle snapshots where system inactivity equals or exceeds 180 seconds.
* Calculates Semantic Task Alignment (Sa) from active weights.
* Counts transitions from work to drifting states to calculate Flow Continuity (Sf).
* Reads local Git logs (git log --since=24.hours) to determine Outcome Multiplier (Sd).
* Computes final Composite Drift Index (CDI) score locally.


3. CENTRAL SERVER & DASHBOARD (server.py + backend_dashboard.db)
* Receives anonymized JSON payload containing final score and aggregate stats.
* Saves metrics via FastAPI/Flask server without storing raw window logs.
* Displays True Focus Percentage on the Employer Web Portal.



# ================================================================================
STEP-BY-STEP MATHEMATICAL EXECUTION

1. SEMANTIC ALIGNMENT SCORE (Sa)
Evaluates window snapshot weights across active non-idle time.
* App Weights:
* 1.0 (on_track)     : IDEs, active terminal running repo.
* 0.6 (support_tool) : StackOverflow, Jira, documentation.
* 0.0 (drifting)     : YouTube, social media, non-work streams.


* Inactivity Filter:
* Snapshots with inactivity >= 180 seconds are pruned entirely.




Formula:
Sa = (Sum of Active Sample Weights) / (Total Non-Idle Samples)
2. FLOW CONTINUITY PENALTY (Sf)
Applies an exponential decay penalty based on direct transitions from productive
states (on_track / support_tool) into drifting states.
Formula:
Sf = exp(-0.05 * N_switches)
* Impact Benchmarks:
* 0 Switches  --> Sf = 1.00 (100.0% flow retained)
* 5 Switches  --> Sf = 0.77 ( 77.0% flow retained)
* 30 Switches --> Sf = 0.22 ( 22.0% flow retained)




3. ARTIFACT DELIVERY MULTIPLIER (Sd)
Inspects local Git output to verify tangible coding progress.
* Multipliers:
* 1.20x Bonus   : Verified Git commit or code churn (>20 lines) detected.


* 0.85x Penalty : Active > 1 hr (>12 active samples) with 0 Git commits or line changes.


* 1.00x Neutral : Default baseline for short sessions.







# ================================================================================
VERIFIED SIMULATION OUTPUT (simulate_session.py)

Input Metrics:

* Semantic Alignment (Sa) : 73.08% (Derived from 156 active snapshots)
* Flow Continuity (Sf)    : 22.31% (Penalized due to 30 context switches)
* Artifact Multiplier (Sd): 1.20x  (1 Verified Commit with +120/-15 churn)

Formula Calculation (alpha = 0.7, beta = 0.3):

1. Base Score = (0.7 * 0.7308) + (0.3 * 0.2231)
= 0.51156 + 0.06693
= 0.57849
2. Final CDI  = Min(100, 0.57849 * 1.20 * 100)
= 69.42%

# ================================================================================
KEY ARCHITECTURAL BENEFITS

* Un-gameable Metrics: Prevents idle IDE squatting via the outcome multiplier (Sd)
and penalizes constant task-switching via flow continuity decay (Sf).
* Privacy Preserving: Raw window titles, process logs, and source code remain on
the local client machine. Only sanitized CDI percentages and active session hours
are transmitted to the central server.

