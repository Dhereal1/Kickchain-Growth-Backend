# Hostinger VPS deploy (Docker Compose)

This repo contains 3 services:

- `kickchain-backend` (Node/Express, port `3004`)
- `telethon-service` (FastAPI/Telethon, internal port `8000`)
- `crawlee-service` (Node/Crawlee, internal port `8002`)

Recommended: run all 3 on the VPS in one `docker compose` stack so the backend can call Telethon/Crawlee over the internal Docker network.

## 1) Install Docker

On Ubuntu:

- Install Docker Engine + Compose plugin (official docs).

## 2) Clone and configure

- `git clone <your repo>`
- `cd kickchain-backend`
- Copy env templates:
  - `cp deploy/vps/backend.env.example deploy/vps/backend.env`
  - `cp deploy/vps/telethon.env.example deploy/vps/telethon.env`
  - `cp deploy/vps/crawlee.env.example deploy/vps/crawlee.env`

Edit the env files:

- `deploy/vps/backend.env`: set `DATABASE_URL`, `BOT_TOKEN`, etc.
- `deploy/vps/telethon.env`: set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELETHON_SESSION`.
- `deploy/vps/crawlee.env`: optionally set `CRAWLEE_SERVICE_API_KEY`.

## 3) Start the stack

- `docker compose -f deploy/vps/docker-compose.yml up -d --build`
- `docker compose -f deploy/vps/docker-compose.yml ps`

## 4) Wire internal service URLs

The compose file sets these for the backend:

- `TELETHON_SERVICE_URL=http://telethon:8000`
- `CRAWLEE_SERVICE_URL=http://crawlee:8002`

If you want to point to *remote* Telethon/Crawlee instead, override those env vars in `deploy/vps/backend.env`.

## 5) Reverse proxy (optional, recommended)

Put Nginx in front of the backend, terminate TLS, and proxy to `127.0.0.1:3004`.

Example server block template is in `deploy/vps/nginx/kickchain-backend.conf`.

## 6) Automatic scraping (/run replacement)

To run the workspace discovery/scraping automatically (no manual `/run`), set in `deploy/vps/backend.env`:

- `INTERNAL_GROUP_IDS=-100123...,-100456...` (Telegram group chat IDs to post results into)
- `INTEL_API_KEY=...` (admin key; also used by operator UI)
- `ENABLE_WORKSPACE_AUTO_RUN=true`

Defaults:

- Runs every ~10 hours (configurable via `WORKSPACE_AUTO_RUN_CRON`)
- Enqueues jobs and processes them in the background (runner tick controlled by `ENABLE_WORKSPACE_RUNNER_SCHEDULER`)

## Feature flags + canary rollouts

This backend uses env-var feature flags (see `.env.example`, and set them in `deploy/vps/backend.env`).

Recommended rollout process:

- Flip **one** flag at a time.
- Do a canary deploy first (enable the flag on a single instance / environment), watch logs and error rate, then roll out broadly.
- Keep a running checklist / go-no-go notes in `tasks`.

PR6 cron (when enabled): `GET /cron/pr6-referral-optimizer` (supports `?dry_run=1` and `&format=team`), protected by `CRON_SECRET` like other cron endpoints. Guardrails: per-user 7d nudge cap + 30d bonus cap via PR6 env vars.
