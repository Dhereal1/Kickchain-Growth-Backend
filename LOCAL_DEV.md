# Local development (polling-only bot)

This repo is set up to run the Telegram bot via long-polling (no webhook).

## Option A: run everything via Docker Compose

1) Copy env template:

- `cp .env.example .env`

2) Fill required values in `.env`:

- `DATABASE_URL=...`
- `BOT_TOKEN=...`
- (optional) Telethon: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELETHON_SESSION`

3) Start services:

- `docker compose up -d --build`

Backend: `http://127.0.0.1:3004` (includes operator UI at `/operator`)

Mini App UI: `http://127.0.0.1:3004/miniapp` (Telegram WebApp; requires `BOT_TOKEN` to call `/miniapp/api/*`).

## Mini App (local) via ngrok

Telegram Mini Apps must be reachable over public HTTPS. To test locally:

1) Start backend: `npm run dev`
2) Start a narrow proxy (only exposes `/miniapp/*`): `npm run miniapp:proxy`
3) Start tunnel: `npm run tunnel:miniapp`
3) Set `.env`:
   - `MINIAPP_PUBLIC_URL=https://<your-ngrok-domain>` (auto-written by `npm run tunnel:miniapp`)
   - `BOT_USERNAME=<your_bot_username>` (no `@`, enables referral links)
4) In Telegram, open your bot and run: `/app`

## Mini App (local) via Cloudflare Quick Tunnel (no domain)

If you don't have a domain and ngrok shows an interstitial warning page, Cloudflare Quick Tunnel works well for Telegram WebApps.

1) Start backend: `npm run dev`
2) Start a narrow proxy (only exposes `/miniapp/*`): `npm run miniapp:proxy`
3) Start tunnel (requires `cloudflared` installed): `npm run tunnel:miniapp:cloudflare`
4) In Telegram, open your bot and run: `/app`

## Option B: run services manually

- Backend (includes bot polling): `npm run dev`
- Telethon service: `cd telethon-service && uvicorn app.main:app --host 0.0.0.0 --port 8000`
- Crawlee service: `cd crawlee-service && npm install && npm run dev`

Notes:

- If polling fails with Telegram `409` errors, the backend will try to clear the webhook automatically (`TELEGRAM_CLEAR_WEBHOOK_ON_POLLING=true`).
