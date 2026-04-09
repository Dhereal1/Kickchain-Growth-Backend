import asyncio
import os

from telethon import TelegramClient
from telethon.sessions import StringSession


async def main() -> None:
    api_id = os.getenv("TELEGRAM_API_ID")
    api_hash = os.getenv("TELEGRAM_API_HASH")
    if not api_id or not api_hash:
        raise SystemExit("Set TELEGRAM_API_ID and TELEGRAM_API_HASH env vars before running.")

    print("Logging in… you will be prompted for phone + code (and password if enabled).")
    async with TelegramClient(StringSession(), int(api_id), api_hash) as client:
        session = client.session.save()
        print("\n✅ TELETHON_SESSION (save this as env var):\n")
        print(session)


if __name__ == "__main__":
    asyncio.run(main())

