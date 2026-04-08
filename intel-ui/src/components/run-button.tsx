"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

type RunResponse = {
  ok: boolean;
  extraction?: any;
  search?: any;
  scrape?: any;
  rankings?: any;
  error?: string;
  details?: string;
};

export function RunButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string>("");

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <div className="text-xs text-zinc-400">Discovery runner</div>
      <h1 className="text-lg font-semibold tracking-tight">Run</h1>

      <div className="mt-4 flex items-center gap-2">
        <button
          className="h-10 rounded-xl bg-emerald-500 text-zinc-950 px-4 text-sm font-medium hover:bg-emerald-400 disabled:opacity-60"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            setResult(null);
            try {
              const r = await apiFetch<RunResponse>("/api/intel/discovery/run", {
                method: "POST",
                body: JSON.stringify({
                  scrape: true,
                }),
              });
              setResult(r);
            } catch (err: any) {
              setError(err?.message || "Run failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Running…" : "Run Discovery"}
        </button>
        <div className="text-xs text-zinc-500">
          Triggers: message extraction → (optional) search → scrape → rankings.
        </div>
      </div>

      {error ? <div className="mt-4 text-sm text-rose-300">{error}</div> : null}

      {result ? (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-zinc-200 font-medium">OK</span>
            <span className="text-zinc-500">•</span>
            <span className="text-zinc-400">
              Search added: <span className="text-zinc-200">{Number(result.search?.added_count || 0)}</span>
            </span>
            <span className="text-zinc-400">
              Scraped: <span className="text-zinc-200">{Number(result.scrape?.scraped_count || 0)}</span>
            </span>
            <span className="text-zinc-400">
              Skipped: <span className="text-zinc-200">{Number(result.scrape?.skipped_count || 0)}</span>
            </span>
          </div>
          <div className="mt-3 text-xs text-zinc-500">
            Tip: go to <span className="text-zinc-200">Results</span> to view AI-ranked communities.
          </div>
        </div>
      ) : null}
    </div>
  );
}

