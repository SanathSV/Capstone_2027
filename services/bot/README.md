# Astra Bot

Playwright (Python) headless Chromium agent that joins a Google Meet call, captures
captions/audio, and uploads the result to the backend.

```bash
cp .env.example .env
python -m venv .venv && .venv/Scripts/activate
pip install -r requirements.txt
playwright install chromium
python -m app.main
```

The bot only captures and uploads — summarization and storage belong to the backend.
