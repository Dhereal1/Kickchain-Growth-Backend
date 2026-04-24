# Crawlee Service (Kickchain Intel)

Standalone Telegram link discovery service using Crawlee (CheerioCrawler).

## Why a separate service

- Keeps search discovery off serverless runtimes when desired.
- Lets the backend call a single internal URL for discovery.

## Setup (local)

1. Install deps:
   - `npm install`
2. Configure env (see `.env.example`)
3. Run:
   - `npm start`

## API

- `GET /health`
- `POST /search`

Auth (optional):
- send header `x-api-key: <CRAWLEE_SERVICE_API_KEY>`

`POST /search` request:

```json
{
  "queries": ["telegram crypto group", "web3 gaming telegram group"],
  "engine": "duckduckgo",
  "max_links": 200,
  "pages_per_query": 1,
  "timeout_ms": 12000
}
```

Response:

```json
{
  "ok": true,
  "engine": "duckduckgo",
  "queries": ["..."],
  "links": ["https://t.me/..."]
}
```

