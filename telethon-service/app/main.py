from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from telethon import TelegramClient, functions
from telethon.errors import FloodWaitError
from telethon.sessions import StringSession
from telethon.tl.types import Channel, Chat

from . import config


class RunRequest(BaseModel):
    queries: list[str] = Field(default_factory=list)
    max_groups_per_query: int | None = None
    max_groups_total: int | None = None
    max_messages_per_group: int | None = None


class MessageOut(BaseModel):
    id: int
    date: str | None
    text: str | None
    views: int | None = 0


class GroupOut(BaseModel):
    username: str
    title: str | None = None
    type: str = "group"  # group | channel
    messages: list[MessageOut] = Field(default_factory=list)


app = FastAPI(title="Kickchain Telethon Service", version="1.0.0")
_client: TelegramClient | None = None


@app.on_event("startup")
async def _startup() -> None:
    global _client
    if not config.TELEGRAM_API_ID or not config.TELEGRAM_API_HASH:
        raise RuntimeError("Missing TELEGRAM_API_ID / TELEGRAM_API_HASH")
    if not config.TELETHON_SESSION:
        raise RuntimeError("Missing TELETHON_SESSION (generate with scripts/create_session.py)")

    _client = TelegramClient(
        StringSession(config.TELETHON_SESSION),
        int(config.TELEGRAM_API_ID),
        config.TELEGRAM_API_HASH,
    )
    await _client.connect()
    if not await _client.is_user_authorized():
        raise RuntimeError("Telethon session is not authorized. Re-generate TELETHON_SESSION.")


@app.on_event("shutdown")
async def _shutdown() -> None:
    global _client
    if _client:
        await _client.disconnect()
        _client = None


def _auth(api_key: str | None) -> None:
    required = config.TELETHON_SERVICE_API_KEY
    if not required:
        return
    if not api_key or api_key.strip() != required:
        raise HTTPException(status_code=401, detail="unauthorized")


def _normalize_username(username: str | None) -> str | None:
    if not username:
        return None
    u = username.strip()
    if not u:
        return None
    if not u.startswith("@"):
        u = f"@{u}"
    return u


def _entity_type(entity: Any) -> str:
    if isinstance(entity, Channel):
        return "group" if getattr(entity, "megagroup", False) else "channel"
    if isinstance(entity, Chat):
        return "group"
    return "unknown"


async def _search_public_groups(query: str, limit: int) -> list[Any]:
    assert _client is not None
    res = await _client(
        functions.contacts.SearchRequest(
            q=query,
            limit=limit,
        )
    )
    # results are in res.chats
    return list(getattr(res, "chats", []) or [])


async def _fetch_last_messages(entity: Any, limit: int) -> list[MessageOut]:
    assert _client is not None
    msgs = await _client.get_messages(entity, limit=limit)
    out: list[MessageOut] = []
    for m in msgs:
        out.append(
            MessageOut(
                id=int(m.id),
                date=m.date.isoformat() if getattr(m, "date", None) else None,
                text=getattr(m, "message", None),
                views=int(getattr(m, "views", 0) or 0),
            )
        )
    return out


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "time": time.time()}


@app.post("/run")
async def run(req: RunRequest, x_api_key: str | None = Header(default=None)) -> dict[str, Any]:
    _auth(x_api_key)
    if _client is None:
        raise HTTPException(status_code=503, detail="client_not_ready")

    queries = [q.strip() for q in (req.queries or []) if q and q.strip()]
    if not queries:
        raise HTTPException(status_code=400, detail="queries required")

    max_per_query = req.max_groups_per_query or config.MAX_GROUPS_PER_QUERY
    max_total = req.max_groups_total or config.MAX_GROUPS_TOTAL
    max_msgs = req.max_messages_per_group or config.MAX_MESSAGES_PER_GROUP
    delay_s = max(0.0, (config.REQUEST_DELAY_MS or 0) / 1000.0)

    # Discover
    seen: dict[str, Any] = {}
    for q in queries:
        try:
            chats = await _search_public_groups(q, limit=max_per_query)
        except FloodWaitError as e:
            retry = int(getattr(e, "seconds", 0) or 0)
            raise HTTPException(status_code=429, detail={"error": "flood_wait", "retry_after": retry})

        for c in chats:
            username = _normalize_username(getattr(c, "username", None))
            if not username:
                continue  # only public entities
            if username not in seen:
                seen[username] = c
            if len(seen) >= max_total:
                break
        if len(seen) >= max_total:
            break
        if delay_s:
            await asyncio.sleep(delay_s)

    # Fetch messages
    groups_out: list[GroupOut] = []
    for username, entity in list(seen.items())[:max_total]:
        kind = _entity_type(entity)
        # Skip channels if you want group-only; keep both for now.
        try:
            msgs = await _fetch_last_messages(entity, limit=max_msgs)
        except FloodWaitError as e:
            retry = int(getattr(e, "seconds", 0) or 0)
            raise HTTPException(status_code=429, detail={"error": "flood_wait", "retry_after": retry})
        groups_out.append(
            GroupOut(
                username=username,
                title=getattr(entity, "title", None),
                type=kind,
                messages=msgs,
            )
        )
        if delay_s:
            await asyncio.sleep(delay_s)

    return {"ok": True, "groups": [g.model_dump() for g in groups_out]}

