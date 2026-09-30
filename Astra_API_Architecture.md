# Astra API Architecture

## Purpose

This API architecture is designed to work directly with the DynamoDB schema:

- `AstraEmployees`
- `AstraProjects`
- `AstraProjectMemberships`
- `AstraProjectState`

Core principle:

> External systems and the Rust agent submit events/evidence. They do not directly overwrite project progress. Astra's state engine evaluates evidence and performs state transitions.

## 1. API Structure

```text
/api/v1
├── /agent
├── /integrations
│   ├── /github
│   └── /jira
├── /internal
│   ├── /attribution
│   ├── /evidence
│   └── /state
├── /management
└── /analytics
```

## 2. Responsibility

| Domain | Caller | Read | Write | Purpose |
|---|---|---:|---:|---|
| `/agent` | Rust agent | Limited | Yes | Activity, registration, heartbeat |
| `/integrations/github` | GitHub | No | Yes | GitHub evidence ingestion |
| `/integrations/jira` | Jira | No | Yes | Jira evidence ingestion |
| `/internal/attribution` | ML worker | Yes | Yes | Task attribution |
| `/internal/evidence` | Workers | Yes | Yes | Evidence processing |
| `/internal/state` | State engine | Yes | Yes | Authoritative state transitions |
| `/management` | Management UI | Yes | Limited | Operational views and controlled overrides |
| `/analytics` | Management UI | Yes | No | Trends and workforce analysis |

## 3. DynamoDB Mapping

### AstraEmployees

```text
PK = employee_id
```

Used by:

```text
POST /agent/register
POST /agent/heartbeat
GET  /management/employees
GET  /management/employees/{employee_id}
```

### AstraProjects

```text
PK = project_id
```

Used by:

```text
GET /management/projects
GET /management/projects/{project_id}
POST /integrations/github/sync
POST /integrations/jira/sync
```

GitHub/Jira secrets should be in AWS Secrets Manager. DynamoDB should contain only integration metadata/references.

### AstraProjectMemberships

Base key:

```text
PK = PROJECT#{project_id}
SK = EMPLOYEE#{employee_id}
```

GSI:

```text
EmployeeProjectsIndex
GSI1PK = EMPLOYEE#{employee_id}
GSI1SK = PROJECT#{project_id}
```

GSI:

```text
ProjectTeamEmployeesIndex
GSI2PK = PROJECT#{project_id}#TEAM#{team_id}
GSI2SK = EMPLOYEE#{employee_id}
```

Used for project → employees, employee → projects, project → teams and team → employees.

### AstraProjectState

Single source of truth for current project/task state.

```text
PK = PROJECT#{project_id}
SK = STATE
SK = TASK#{task_id}
SK = TASK#{task_id}#EVENT#{timestamp}
SK = TASK#{task_id}#EVIDENCE#{evidence_id}
```

GSIs:

```text
EmployeeTasksIndex
TeamTasksIndex
```

## 4. Agent APIs

### POST `/api/v1/agent/register`

Registers a device.

Request:

```json
{
  "employee_id": "EMP_001",
  "device_id": "DEVICE_001",
  "agent_version": "1.2.0",
  "os": "macos"
}
```

Updates agent metadata in `AstraEmployees`.

### POST `/api/v1/agent/heartbeat`

Request:

```json
{
  "device_id": "DEVICE_001",
  "timestamp": "2026-09-30T16:00:00Z",
  "agent_version": "1.2.0"
}
```

Updates heartbeat/device state only.

### POST `/api/v1/agent/events`

Primary Rust-agent ingestion endpoint.

Request:

```json
{
  "device_id": "DEVICE_001",
  "events": [
    {
      "timestamp": "2026-09-30T15:02:11Z",
      "type": "FILE_MODIFIED",
      "repository": "astra",
      "branch": "feature/activity-engine",
      "path": "src/activity/processor.rs"
    },
    {
      "timestamp": "2026-09-30T15:04:11Z",
      "type": "GIT_COMMIT",
      "commit_sha": "abc123"
    }
  ]
}
```

This endpoint must not directly update task progress.

Flow:

```text
Agent
→ /agent/events
→ ingestion
→ activity window
→ candidate task retrieval
→ ML attribution
→ evidence engine
→ state engine
→ AstraProjectState
```

## 5. GitHub APIs

### POST `/api/v1/integrations/github/webhook`

Receives:

```text
push
pull_request
pull_request_review
workflow_run
deployment
```

Normalize GitHub events into Astra evidence events.

Example:

```json
{
  "source": "GITHUB",
  "event_type": "PULL_REQUEST",
  "project_id": "PROJ_001",
  "repository": "astra",
  "pull_request_id": "481",
  "author_employee_id": "EMP_001",
  "branch": "feature/activity-engine",
  "action": "opened",
  "timestamp": "2026-09-30T15:30:00Z"
}
```

### POST `/api/v1/integrations/github/sync`

Used for initial imports, missed webhooks and reconciliation.

Request:

```json
{
  "project_id": "PROJ_001",
  "from": "2026-09-01T00:00:00Z",
  "to": "2026-09-30T23:59:59Z"
}
```

Large syncs should be asynchronous.

## 6. Jira APIs

### POST `/api/v1/integrations/jira/webhook`

Receives:

```text
issue_created
issue_updated
issue_assigned
issue_status_changed
comment_added
```

Example:

```json
{
  "source": "JIRA",
  "event_type": "ISSUE_STATUS_CHANGED",
  "project_id": "PROJ_001",
  "issue_key": "ASTRA-123",
  "old_status": "In Progress",
  "new_status": "Done",
  "assignee_id": "EMP_001",
  "timestamp": "2026-09-30T15:30:00Z"
}
```

### POST `/api/v1/integrations/jira/sync`

Used for initial import, missed webhook recovery and reconciliation.

## 7. Internal Attribution

These endpoints are service-to-service and must not be exposed as normal management APIs.

### POST `/api/v1/internal/attribution/evaluate`

Input:

```json
{
  "employee_id": "EMP_001",
  "project_id": "PROJ_001",
  "activity_window": {
    "start": "2026-09-30T15:00:00Z",
    "end": "2026-09-30T15:15:00Z",
    "repository": "astra",
    "branch": "feature/activity-engine",
    "files": [
      "src/activity/processor.rs"
    ],
    "commits": [
      "abc123"
    ]
  }
}
```

Pipeline:

```text
Activity window
→ deterministic filtering
→ candidate tasks
→ embeddings / pgvector
→ top-K tasks
→ Llama
→ structured attribution
```

Example output:

```json
{
  "employee_id": "EMP_001",
  "attributions": [
    {
      "task_id": "ASTRA-123",
      "confidence": 0.94,
      "recommended_state": "IN_PROGRESS",
      "evidence": [
        "branch_match",
        "file_match",
        "commit_match"
      ]
    }
  ],
  "model_version": "llama-3.2-v1"
}
```

## 8. Evidence Processing

### POST `/api/v1/internal/evidence/process`

Combines evidence from:

```text
Rust
GitHub
Jira
CI
ML attribution
```

Example:

```json
{
  "project_id": "PROJ_001",
  "task_id": "ASTRA-123",
  "evidence": [
    {
      "type": "GITHUB_COMMIT",
      "source_id": "abc123"
    },
    {
      "type": "GITHUB_PR",
      "source_id": "PR_481"
    },
    {
      "type": "CI_TEST",
      "source_id": "RUN_928"
    }
  ]
}
```

Stored in `AstraProjectState` as:

```text
PK = PROJECT#PROJ_001
SK = TASK#ASTRA-123#EVIDENCE#{evidence_id}
```

## 9. State Engine

### POST `/api/v1/internal/state/evaluate`

Example:

```json
{
  "project_id": "PROJ_001",
  "task_id": "ASTRA-123",
  "candidate_state": "LIKELY_COMPLETE",
  "confidence": 0.93,
  "evidence_ids": [
    "EVT_001",
    "EVT_002",
    "EVT_003"
  ]
}
```

The engine evaluates:

```text
Current state
+
Evidence
+
Confidence
+
Rules
+
Acceptance criteria
```

Then performs the state transition.

### State machine

```text
NOT_STARTED
      |
      | activity detected
      v
IN_PROGRESS
      |
      | strong evidence
      v
LIKELY_COMPLETE
      |
      | verification threshold
      v
VERIFIED_COMPLETE
```

Alternative states:

```text
IN_PROGRESS → BLOCKED
IN_PROGRESS → UNKNOWN
ANY STATE   → MANUAL_OVERRIDE
```

Every transition is recorded.

Example event:

```json
{
  "event_type": "STATE_CHANGE",
  "old_status": "IN_PROGRESS",
  "new_status": "LIKELY_COMPLETE",
  "old_progress": 72,
  "new_progress": 91,
  "confidence": 0.93,
  "source": "ASTRA_ENGINE",
  "evidence_ids": [
    "EVT_001",
    "EVT_002"
  ],
  "model_version": "llama-3.2-v1",
  "rule_version": "state-rules-v3",
  "reason": "PR merged and acceptance tests passed",
  "created_at": "2026-09-30T15:30:00Z"
}
```

Stored as:

```text
PK = PROJECT#PROJ_001
SK = TASK#ASTRA-123#EVENT#2026-09-30T15:30:00Z
```

## 10. Management APIs

Management APIs are primarily read-only.

### GET `/api/v1/management/projects`

Returns projects accessible to the manager.

### GET `/api/v1/management/projects/{project_id}`

Reads:

```text
AstraProjects
AstraProjectState
AstraProjectMemberships
```

Example:

```json
{
  "project_id": "PROJ_001",
  "name": "Astra",
  "status": "IN_PROGRESS",
  "health": "ON_TRACK",
  "completion": {
    "percentage": 67,
    "total_tasks": 100,
    "completed": 67,
    "in_progress": 21,
    "blocked": 12
  },
  "teams": 4,
  "employees": 28,
  "last_updated": "2026-09-30T16:00:00Z"
}
```

### GET `/api/v1/management/projects/{project_id}/employees`

DynamoDB query:

```text
PK = PROJECT#{project_id}
SK begins_with EMPLOYEE#
```

### GET `/api/v1/management/projects/{project_id}/teams`

DynamoDB query:

```text
PK = PROJECT#{project_id}
SK begins_with TEAM#
```

### GET `/api/v1/management/projects/{project_id}/teams/{team_id}/employees`

DynamoDB query:

```text
GSI2PK = PROJECT#{project_id}#TEAM#{team_id}
```

### GET `/api/v1/management/employees/{employee_id}`

Uses:

```text
EmployeeProjectsIndex
GSI1PK = EMPLOYEE#{employee_id}
```

### GET `/api/v1/management/employees/{employee_id}/tasks`

Uses:

```text
EmployeeTasksIndex
GSI1PK = EMPLOYEE#{employee_id}
```

### GET `/api/v1/management/tasks/{task_id}`

Returns:

```text
current task
current progress
assignee
team
attribution
evidence
history
```

## 11. Manual Override

The only normal management write should be an explicit audited override.

### POST `/api/v1/management/tasks/{task_id}/override`

Request:

```json
{
  "status": "IN_PROGRESS",
  "reason": "Task requires additional QA work"
}
```

Do not silently overwrite the task.

Create a `MANUAL_OVERRIDE` event in the task history.

## 12. Analytics APIs

Analytics APIs are read-only.

```text
GET /api/v1/analytics/workforce

GET /api/v1/analytics/projects

GET /api/v1/analytics/projects/{project_id}/trend

GET /api/v1/analytics/projects/{project_id}/workload

GET /api/v1/analytics/projects/{project_id}/blockers

GET /api/v1/analytics/employees/{employee_id}/trend

GET /api/v1/analytics/teams/{team_id}/trend

GET /api/v1/analytics/task-completion

GET /api/v1/analytics/attribution
```

### Project trend

```json
{
  "project_id": "PROJ_001",
  "period": "30d",
  "daily_progress": [
    {
      "date": "2026-09-01",
      "completion": 21
    },
    {
      "date": "2026-09-15",
      "completion": 42
    },
    {
      "date": "2026-09-30",
      "completion": 67
    }
  ]
}
```

### Workforce analytics

```json
{
  "period": "30d",
  "employees": 124,
  "active_projects": 17,
  "work_distribution": {
    "project_work": 82,
    "unassigned_work": 8,
    "other": 10
  }
}
```

### Attribution analytics

Useful for evaluating Astra itself:

```json
{
  "period": "30d",
  "windows_processed": 18234,
  "attributions": {
    "high_confidence": 14321,
    "medium_confidence": 2871,
    "low_confidence": 1042
  },
  "manual_overrides": 321,
  "override_rate": 0.0176
}
```

## 13. End-to-End Data Flows

### Rust Agent

```text
Rust Agent
    |
    v
POST /agent/events
    |
    v
API Gateway / FastAPI
    |
    v
SQS
    |
    v
Activity Worker
    |
    v
Activity Window
    |
    v
Candidate Task Retrieval
    |
    v
Llama / Embeddings
    |
    v
Attribution
    |
    v
Evidence Engine
    |
    v
State Engine
    |
    v
AstraProjectState
```

### GitHub

```text
GitHub
   |
   v
POST /integrations/github/webhook
   |
   v
GitHub Adapter
   |
   v
SQS
   |
   v
Evidence Worker
   |
   v
AstraProjectState
```

### Jira

```text
Jira
   |
   v
POST /integrations/jira/webhook
   |
   v
Jira Adapter
   |
   v
SQS
   |
   v
Evidence Worker
   |
   v
State Engine
   |
   v
AstraProjectState
```

### Management dashboard

```text
Next.js Dashboard
       |
       v
GET /management/*
GET /analytics/*
       |
       v
FastAPI
       |
       +---- AstraEmployees
       +---- AstraProjects
       +---- AstraProjectMemberships
       +---- AstraProjectState
```

## 14. AWS Production Layout

```text
                    Internet
                       |
                       v
                 API Gateway
                       |
                       v
                 FastAPI / Lambda
                       |
          +------------+------------+
          |            |            |
          v            v            v
        SQS        DynamoDB     Secrets Manager
          |
    +-----+------+----------------+
    |            |                |
    v            v                v
Activity      Evidence       Attribution
Worker        Worker          Worker
                               |
                               v
                         Ollama / Llama
                               |
                               v
                         State Engine
                               |
                               v
                           DynamoDB
```

For the first production implementation, SQS should provide durable asynchronous processing. Redis can still be used for caching if needed, but should not be the only durable event queue.

## 15. Security Boundaries

### Rust agent

```text
agent:register
agent:heartbeat
agent:events
```

### GitHub

```text
github:webhook
```

### Jira

```text
jira:webhook
```

### ML workers

```text
attribution:write
evidence:write
state:evaluate
```

### Management

```text
projects:read
employees:read
tasks:read
analytics:read
task:override
```

The Rust agent should not have unrestricted DynamoDB write access.

## 16. Final Architecture Rule

```text
             OBSERVATIONS
                  |
       +----------+----------+
       |          |          |
      Rust      GitHub      Jira
       |          |          |
       +----------+----------+
                  |
                  v
               EVIDENCE
                  |
                  v
            ML ATTRIBUTION
                  |
                  v
             STATE ENGINE
                  |
                  v
       +---------------------+
       | AstraProjectState   |
       |                     |
       | Project State       |
       | Task State          |
       | Evidence            |
       | History             |
       +----------+----------+
                  |
             READ ONLY
                  |
       +----------+----------+
       |                     |
       v                     v
 Management              Analytics
 Dashboard               Dashboard
```

The key rule is:

**Do not build an API where GitHub, Jira, or the Rust agent says `set task progress to 73%`.**

Instead, they submit evidence:

```text
"Here is what happened."
```

Astra determines:

```text
Which project?
Which employee?
Which task?
What evidence?
What confidence?
What progress?
What state?
Should the state change?
Why?
```

This keeps `AstraProjectState` as the authoritative source of truth and keeps the API architecture aligned with the DynamoDB schema.
