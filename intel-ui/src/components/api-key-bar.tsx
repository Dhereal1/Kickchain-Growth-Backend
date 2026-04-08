"use client";

import { useEffect, useMemo, useState } from "react";
import { defaultBaseUrl, getApiKey, getBaseUrl, setApiKey, setBaseUrl } from "@/lib/storage";

export function ApiKeyBar() {
  const [apiKey, setApiKeyState] = useState("");
  const [baseUrl, setBaseUrlState] = useState("");
  const [status, setStatus] = useState<"idle" | "saved">("idle");

  useEffect(() => {
    setApiKeyState(getApiKey());
    setBaseUrlState(getBaseUrl() || defaultBaseUrl());
  }, []);

  const keyHint = useMemo(() => {
    if (!apiKey) return "Not set";
    if (apiKey.startsWith("kc_user_")) return "User key";
    if (apiKey.startsWith("kc_live_")) return "Admin key";
    return "Key set";
  }, [apiKey]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="text-xs text-zinc-400">
          Auth: <span className="text-zinc-200 font-medium">{keyHint}</span>
          {status === "saved" ? <span className="ml-2 text-emerald-400">Saved</span> : null}
        </div>
        <button
          className="text-xs rounded-md border border-zinc-800 px-2 py-1 hover:bg-zinc-900"
          onClick={() => {
            setApiKeyState("");
            setBaseUrlState(defaultBaseUrl());
            setApiKey("");
            setBaseUrl(defaultBaseUrl());
            setStatus("saved");
            setTimeout(() => setStatus("idle"), 1200);
          }}
        >
          Clear
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div className="md:col-span-2">
          <div className="text-[11px] text-zinc-500 mb-1">API Base URL</div>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrlState(e.target.value)}
            placeholder={defaultBaseUrl()}
            className="w-full h-10 rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>
        <div>
          <div className="text-[11px] text-zinc-500 mb-1">API Key</div>
          <input
            value={apiKey}
            onChange={(e) => setApiKeyState(e.target.value)}
            placeholder="kc_user_…"
            className="w-full h-10 rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          className="h-9 rounded-lg bg-emerald-500 text-zinc-950 px-3 text-sm font-medium hover:bg-emerald-400"
          onClick={() => {
            setApiKey(apiKey);
            setBaseUrl(baseUrl);
            setStatus("saved");
            setTimeout(() => setStatus("idle"), 1200);
          }}
        >
          Save
        </button>
        <div className="text-xs text-zinc-500">
          Stored in localStorage and added to every request as <span className="text-zinc-300">Bearer</span>.
        </div>
      </div>
    </div>
  );
}

