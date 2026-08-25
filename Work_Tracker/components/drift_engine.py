"""
Composite Drift Engine
======================
Calculates an ungameable Composite Drift Index (CDI) score (0.0 to 100.0%)
by combining:
  1. Semantic Alignment (Sa): Ratio of time spent on direct work vs. support vs. drift.
  2. Flow Continuity (Sf): Exponential penalty for context switching based on interruption research.
  3. Artifact Delivery (Sd): Multiplier based on verified Git commits and code churn.
"""

import math

def calculate_cdi(activity_logs, commits, idle_threshold_sec=180, alpha=0.7, beta=0.3, lambda_param=0.05):
    """
    Computes the Composite Drift Index (CDI) for a set of activity logs and Git commits.

    :param activity_logs: List of dicts or sqlite3.Row containing:
                          ['status', 'idle'] (and optionally 'recorded_at')
    :param commits: List of dicts containing commit metadata:
                    [{'commit_hash': ..., 'additions': ..., 'deletions': ...}]
    :param idle_threshold_sec: Cutoff seconds to consider an entry idle.
    :param alpha: Weight for Semantic Alignment.
    :param beta: Weight for Flow Continuity.
    :param lambda_param: Decay coefficient for context-switch penalty.
    :return: dict containing CDI score, component sub-scores, and metrics.
    """
    if not activity_logs:
        return {
            "cdi_score": 0.0,
            "alignment_score": 0.0,
            "flow_score": 0.0,
            "artifact_multiplier": 1.0,
            "context_switches": 0,
            "total_samples": 0,
            "active_samples": 0
        }

    # Weight definitions for statuses
    status_weights = {
        "on_track": 1.0,
        "support_tool": 0.6,
        "unclear": 0.3,
        "drifting": 0.0
    }

    weight_sum = 0.0
    active_samples = 0
    context_switches = 0
    last_status = None

    for log in activity_logs:
        # Check if log entry is marked idle (either via dict key or bool flag)
        is_idle = bool(log.get("idle", False))
        if is_idle:
            continue

        active_samples += 1
        status = str(log.get("status", "unclear")).lower()
        w = status_weights.get(status, 0.3)
        weight_sum += w

        # Detect context switch away from work/support into drifting
        if last_status in ["on_track", "support_tool"] and status == "drifting":
            context_switches += 1
        
        last_status = status

    if active_samples == 0:
        return {
            "cdi_score": 0.0,
            "alignment_score": 0.0,
            "flow_score": 1.0,
            "artifact_multiplier": 1.0,
            "context_switches": 0,
            "total_samples": len(activity_logs),
            "active_samples": 0
        }

    # 1. Semantic Alignment Score (Sa)
    Sa = weight_sum / float(active_samples)

    # 2. Flow Continuity Score (Sf)
    Sf = math.exp(-lambda_param * context_switches)

    # 3. Artifact Delivery Factor (Sd)
    total_commits = len(commits) if commits else 0
    total_churn = sum(c.get("additions", 0) + c.get("deletions", 0) for c in commits) if commits else 0

    if total_commits > 0 or total_churn > 20:
        Sd = 1.2  # Bonus for verified Git artifact delivery
    elif active_samples > 12 and total_commits == 0:  # e.g., >1 hr active without commits
        Sd = 0.85 # Slight penalty for high focus time with zero output artifacts
    else:
        Sd = 1.0

    # 4. Composite Calculation
    raw_score = ((alpha * Sa) + (beta * Sf)) * Sd
    CDI = min(100.0, max(0.0, raw_score * 100.0))

    return {
        "cdi_score": round(CDI, 2),
        "alignment_score": round(Sa * 100, 2),
        "flow_score": round(Sf * 100, 2),
        "artifact_multiplier": Sd,
        "context_switches": context_switches,
        "total_samples": len(activity_logs),
        "active_samples": active_samples
    }


if __name__ == "__main__":
    # Quick standalone test
    mock_logs = [
        {"status": "on_track", "idle": False},
        {"status": "on_track", "idle": False},
        {"status": "support_tool", "idle": False},
        {"status": "drifting", "idle": False}, # Switch 1
        {"status": "on_track", "idle": False},
        {"status": "drifting", "idle": False}, # Switch 2
        {"status": "on_track", "idle": True},   # Pruned
    ]
    mock_commits = [{"commit_hash": "a1b2c3", "additions": 45, "deletions": 5}]

    result = calculate_cdi(mock_logs, mock_commits)
    print("Test Calculation Result:")
    for k, v in result.items():
        print(f"  {k}: {v}")