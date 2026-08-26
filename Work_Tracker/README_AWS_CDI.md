# CDI Engine: AWS Deployment Blueprint

This project is being split into two parts:

1. Local packaged client: a privacy-first Rust binary that collects session metadata and uploads sanitized CDI summaries.
2. Cloud backend: a serverless system on AWS that receives telemetry, stores it in DynamoDB, and serves dashboard queries.

## Local client responsibilities
- Poll active window metadata every few seconds
- Run classification and CDI math locally
- Cache telemetry in SQLite
- Push only sanitized summaries to the cloud after user consent
- Retry if network is unavailable

## Cloud backend responsibilities
- Accept sync uploads over API Gateway
- Validate API keys and request schema
- Push events to an SQS FIFO queue
- Process with Lambda worker
- Write raw session records and daily rollups to DynamoDB
- Serve user and org dashboard data via FastAPI + Mangum

## AWS serverless stack
- API Gateway
- SQS FIFO queue with DLQ
- Lambda ingestion worker
- DynamoDB `CDI_Main`
- FastAPI/Mangum dashboard API

## Run locally

### Python backend packaging
```bash
cd server-python
python3 -m venv .venv
source .venv/bin/activate
pip install -r src/requirements.txt
```

### AWS SAM build
```bash
cd server-python
sam build
sam deploy --guided
```

### Rust client
```bash
cd client-rust
cargo build --release
```

Environment variables for the Rust client:
```bash
export CDI_API_BASE_URL="https://<api-id>.execute-api.<region>.amazonaws.com/dev"
export CDI_API_KEY="your-api-key"
export CDI_ORG_ID="org-001"
export CDI_USER_ID="user-001"
export CDI_TIMEOUT_SECONDS="15"
```

Optional config file:
```bash
~/.cdi-agent.conf
CDI_API_BASE_URL=https://...
CDI_API_KEY=...
CDI_ORG_ID=org-001
CDI_USER_ID=user-001
CDI_TIMEOUT_SECONDS=15
```

## Security notes
- Keep secrets outside source control
- Use API Gateway keys or IAM auth
- Do not send raw window contents, keystrokes, screenshots, or full URLs
- Restrict DynamoDB and SQS access with least privilege

## Typical flow
1. Rust client collects session data locally
2. CDI is calculated locally
3. Sanitized session is posted to `/v1/telemetry/sync`
4. API Gateway validates request and pushes to SQS
5. Lambda worker writes session + rollup records to DynamoDB
6. Dashboard API reads user/org summaries for the UI
