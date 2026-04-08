import { getApiKey, getBaseUrl } from "./storage";

export type ApiError = Error & { status?: number; data?: any };

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl().replace(/\/+$/, "");
  const apiKey = getApiKey();
  if (!apiKey) {
    const err: ApiError = new Error("Missing API key. Add it at the top.");
    err.status = 401;
    throw err;
  }

  const url = `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
      Authorization: `Bearer ${apiKey}`,
    },
    cache: "no-store",
  });

  const text = await r.text().catch(() => "");
  const data = text ? JSON.parse(text) : null;

  if (!r.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${r.status}`;
    const err: ApiError = new Error(String(msg));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

