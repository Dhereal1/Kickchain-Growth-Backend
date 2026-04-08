"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";

type IntelConfig = {
  ok?: boolean;
  user_id?: number;
  datasets?: string[] | null;
  keywords?: string[] | null;
  intent_keywords?: string[] | null;
  thresholds?: any;
  updated_at?: string | null;
};

function linesToArray(v: string) {
  return String(v || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function arrayToLines(v: any) {
  return Array.isArray(v) ? v.map(String).filter(Boolean).join("\n") : "";
}

export function ConfigForm() {
  const [queries, setQueries] = useState("");
  const [intent, setIntent] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  const queryCount = useMemo(() => linesToArray(queries).length, [queries]);
  const intentCount = useMemo(() => linesToArray(intent).length, [intent]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setStatus("loading");
      setMessage("");
      try {
        const cfg = await apiFetch<IntelConfig>("/api/intel/config");
        if (!alive) return;
        const t = cfg.thresholds && typeof cfg.thresholds === "object" ? cfg.thresholds : {};
        setQueries(arrayToLines(t.discovery_queries));
        setIntent(arrayToLines(cfg.intent_keywords));
        setStatus("idle");
      } catch (err: any) {
        if (!alive) return;
        setStatus("error");
        setMessage(err?.message || "Failed to load config");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-400">Discovery configuration</div>
          <h1 className="text-lg font-semibold tracking-tight">Config</h1>
        </div>
        <div className="text-xs text-zinc-400">
          {status === "loading" ? "Loading…" : status === "saved" ? "Saved" : status === "error" ? "Error" : "Ready"}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Queries</div>
            <div className="text-xs text-zinc-500">{queryCount}/50</div>
          </div>
          <div className="text-xs text-zinc-500 mt-1">Newline-separated search queries used by discovery.</div>
          <textarea
            value={queries}
            onChange={(e) => setQueries(e.target.value)}
            rows={10}
            placeholder={[
              "telegram crypto group",
              "telegram betting group",
              "web3 gaming telegram group",
              "telegram gambling chat",
              "telegram crypto signals group",
            ].join("\n")}
            className="mt-2 w-full rounded-xl bg-zinc-900/40 border border-zinc-800 p-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Intent keywords</div>
            <div className="text-xs text-zinc-500">{intentCount}/50</div>
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            Used by the intel pipeline to detect “intent”. Keep it short and specific.
          </div>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={10}
            placeholder={["any game", "recommend", "looking for", "what to play", "need"].join("\n")}
            className="mt-2 w-full rounded-xl bg-zinc-900/40 border border-zinc-800 p-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          disabled={status === "loading"}
          className="h-10 rounded-xl bg-emerald-500 text-zinc-950 px-4 text-sm font-medium hover:bg-emerald-400 disabled:opacity-60"
          onClick={async () => {
            setStatus("loading");
            setMessage("");
            try {
              await apiFetch<{ ok: boolean }>("/api/intel/config", {
                method: "POST",
                body: JSON.stringify({
                  intent_keywords: linesToArray(intent),
                  thresholds: {
                    discovery_queries: linesToArray(queries),
                  },
                }),
              });
              setStatus("saved");
              setTimeout(() => setStatus("idle"), 1200);
            } catch (err: any) {
              setStatus("error");
              setMessage(err?.message || "Failed to save");
            }
          }}
        >
          Save config
        </button>
        <div className="text-xs text-zinc-500">Saved per user (multi-tenant).</div>
      </div>

      {message ? (
        <div className="mt-3 text-sm text-rose-300">{message}</div>
      ) : (
        <div className="mt-3 text-xs text-zinc-500">
          Notes: Discovery uses these queries when you don’t pass queries explicitly during a run.
        </div>
      )}
    </div>
  );
}

