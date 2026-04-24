# Hostinger VPS deploy (Docker Compose)

This repo contains 3 services:

- `kickchain-backend` (Node/Express, port `3000`)
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

Put Nginx in front of the backend, terminate TLS, and proxy to `127.0.0.1:3000`.

Example server block template is in `deploy/vps/nginx/kickchain-backend.conf`.

