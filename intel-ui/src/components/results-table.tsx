"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";

type Row = {
  community: string;
  score: number;
  total_messages?: number;
  total_intent?: number;
  avg_intent?: number;
  category?: string;
  ai?: {
    quality_score?: number;
    recommended_action?: "join" | "monitor" | "ignore";
    summary?: string;
    intent_detected?: boolean;
    cached?: boolean;
    skipped?: boolean;
    reason?: string;
  };
};

function actionStyle(a?: string) {
  const action = String(a || "").toLowerCase();
  if (action === "join") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/25";
  if (action === "monitor") return "bg-amber-500/15 text-amber-200 border-amber-500/25";
  if (action === "ignore") return "bg-zinc-800/60 text-zinc-300 border-zinc-700";
  return "bg-zinc-900/40 text-zinc-300 border-zinc-800";
}

export function ResultsTable() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let alive = true;
    (async () => {
      setStatus("loading");
      setError("");
      try {
        const data = await apiFetch<Row[]>("/api/intel/discovered-communities?include_ai=1&ai_limit=10");
        if (!alive) return;
        setRows(Array.isArray(data) ? data : []);
        setStatus("idle");
      } catch (err: any) {
        if (!alive) return;
        setStatus("error");
        setError(err?.message || "Failed to load results");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const joinCount = useMemo(
    () => rows.filter((r) => String(r.ai?.recommended_action || "").toLowerCase() === "join").length,
    [rows]
  );

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-400">AI-analyzed ranked communities</div>
          <h1 className="text-lg font-semibold tracking-tight">Results</h1>
        </div>
        <div className="text-xs text-zinc-400">
          {status === "loading" ? "Loading…" : `${rows.length} rows • JOIN ${joinCount}`}
        </div>
      </div>

      {status === "error" ? <div className="mt-4 text-sm text-rose-300">{error}</div> : null}

      <div className="mt-4 overflow-auto rounded-xl border border-zinc-800">
        <table className="min-w-[980px] w-full text-sm">
          <thead className="bg-zinc-950">
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
              <th className="py-3 px-3 font-medium">Community</th>
              <th className="py-3 px-3 font-medium text-right">Score</th>
              <th className="py-3 px-3 font-medium text-right">AI Quality</th>
              <th className="py-3 px-3 font-medium">Action</th>
              <th className="py-3 px-3 font-medium">Summary</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const action = r.ai?.recommended_action || "";
              const q = r.ai?.quality_score;
              return (
                <tr key={r.community} className="border-b border-zinc-900 hover:bg-zinc-900/30">
                  <td className="py-3 px-3">
                    <div className="font-medium text-zinc-100">{r.community}</div>
                    <div className="text-xs text-zinc-500">
                      msgs {Number(r.total_messages || 0)} • intent {Number(r.total_intent || 0)}
                      {r.ai?.cached ? <span className="ml-2 text-emerald-300/80">cached</span> : null}
                      {r.ai?.skipped ? <span className="ml-2 text-amber-300/80">{r.ai?.reason || "skipped"}</span> : null}
                    </div>
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums text-zinc-200 font-medium">
                    {Number(r.score || 0).toFixed(1)}
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums text-zinc-200">
                    {typeof q === "number" ? q.toFixed(1) : "—"}
                  </td>
                  <td className="py-3 px-3">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${actionStyle(action)}`}>
                      {String(action || "—").toUpperCase()}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-zinc-300">
                    <div className="max-w-[680px] truncate">
                      {r.ai?.summary || (r.ai?.skipped ? "AI skipped for this community." : "—")}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && status !== "loading" ? (
              <tr>
                <td colSpan={5} className="py-10 text-center text-zinc-500">
                  No rows yet. Run discovery, then come back to Results.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-xs text-zinc-500">
        Highlight rules: JOIN = green, MONITOR = yellow, IGNORE = gray.
      </div>
    </div>
  );
}

