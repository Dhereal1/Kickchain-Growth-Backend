import os


def _env(name: str, default: str | None = None) -> str | None:
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


TELEGRAM_API_ID = _env("TELEGRAM_API_ID")
TELEGRAM_API_HASH = _env("TELEGRAM_API_HASH")
TELETHON_SESSION = _env("TELETHON_SESSION")
TELETHON_SERVICE_API_KEY = _env("TELETHON_SERVICE_API_KEY")

MAX_GROUPS_PER_QUERY = int(_env("MAX_GROUPS_PER_QUERY", "5") or "5")
MAX_GROUPS_TOTAL = int(_env("MAX_GROUPS_TOTAL", "10") or "10")
MAX_MESSAGES_PER_GROUP = int(_env("MAX_MESSAGES_PER_GROUP", "20") or "20")
REQUEST_DELAY_MS = int(_env("REQUEST_DELAY_MS", "250") or "250")

