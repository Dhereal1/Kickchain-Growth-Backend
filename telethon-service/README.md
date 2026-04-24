# Telethon Service (Kickchain Intel)

Persistent Telegram data collector using Telethon + FastAPI.

## Why a separate service

- Telethon needs a persistent session and long-lived process.
- Don’t run it on Vercel (serverless + ephemeral filesystem).
- Deploy to Railway (or any container host).

## Setup (local)

1. Install deps:
   - `pip install -r requirements.txt`
2. Create a session string (runs once):
   - `set TELEGRAM_API_ID=...`
   - `set TELEGRAM_API_HASH=...`
   - `python scripts/create_session.py`
3. Set env vars (see `.env.example`):
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`
   - `TELETHON_SESSION`
   - optionally `TELETHON_SERVICE_API_KEY`
4. Run:
   - `uvicorn app.main:app --host 0.0.0.0 --port 8000`

## API

- `GET /health`
- `POST /run`
- `POST /fetch`

Request:

```json
{
  "queries": [
    "telegram crypto group",
    "web3 gaming telegram group"
  ],
  "max_groups_total": 10,
  "max_messages_per_group": 20
}
```

Auth (optional):
- send header `x-api-key: <TELETHON_SERVICE_API_KEY>`

Response:
- `groups[]` with `username`, `title`, `type`, and `messages[]`.

`POST /fetch` request:

```json
{
  "usernames": ["@somegroup", "https://t.me/anothergroup"],
  "max_messages_per_group": 50
}
```

## Railway deploy

## VPS deploy (Docker)

- Build and run via the root `deploy/vps/docker-compose.yml` (recommended), or build this folder’s `Dockerfile` directly.
- Add env vars from `.env.example` (or `deploy/vps/telethon.env.example`).
- Keep the service always-on (needed for session reuse).
