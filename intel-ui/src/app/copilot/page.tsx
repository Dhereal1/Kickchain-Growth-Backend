"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";

type ActionItem = {
  type: string;
  entity_key: string;
  community_name?: string;
  stage?: string;
  score?: number;
  reason?: string;
  suggested_next_step?: string;
  last_outreach_at?: string | null;
  ai_summary?: string | null;
};

export default function CopilotPage() {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");

  const [selected, setSelected] = useState<ActionItem | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [draftStatus, setDraftStatus] = useState<"idle" | "loading" | "error">("idle");
  const [draftError, setDraftError] = useState("");
  const [tone, setTone] = useState("friendly");

  async function load() {
    setStatus("loading");
    setError("");
    try {
      const out = await apiFetch<{ ok: boolean; items: ActionItem[] }>("/api/copilot/actions?limit=20");
      setItems(Array.isArray(out.items) ? out.items : []);
      setStatus("idle");
    } catch (err: any) {
      setStatus("error");
      setError(err?.message || "Failed to load actions");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const summary = useMemo(() => {
    const top = items[0];
    return top ? `Top: ${top.community_name || top.entity_key} (${Number(top.score || 0)})` : "—";
  }, [items]);

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-400">Read-only advisory</div>
          <h1 className="text-lg font-semibold tracking-tight">AI Copilot</h1>
        </div>
        <div className="flex items-center gap-2">
          <button className="text-xs rounded-md border border-zinc-800 px-2 py-1 hover:bg-zinc-900" onClick={load}>
            Refresh
          </button>
          <div className="text-xs text-zinc-400">{status === "loading" ? "Loading…" : summary}</div>
        </div>
      </div>

      {error ? <div className="mt-4 text-sm text-rose-300">{error}</div> : null}

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="text-xs text-zinc-400">Today’s Recommended Actions</div>
          <div className="mt-3 grid gap-2">
            {items.length ? (
              items.map((it, idx) => (
                <button
                  key={it.entity_key + idx}
                  className={`text-left rounded-xl border px-3 py-2 hover:bg-zinc-900/30 ${
                    selected?.entity_key === it.entity_key ? "border-emerald-500/40 bg-emerald-500/5" : "border-zinc-800 bg-zinc-950/60"
                  }`}
                  onClick={() => {
                    setSelected(it);
                    setDraft("");
                    setDraftError("");
                    setDraftStatus("idle");
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-zinc-100 truncate">
                        {it.community_name || it.entity_key}
                      </div>
                      <div className="mt-1 text-xs text-zinc-500 truncate">
                        {it.suggested_next_step || it.reason || "—"}
                      </div>
                    </div>
                    <div className="text-xs text-zinc-400 tabular-nums">
                      {typeof it.score === "number" ? it.score : "—"}
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <div className="text-xs text-zinc-500">No actions yet. Populate the Growth CRM pipeline first.</div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-zinc-400">Draft outreach</div>
            <select
              className="h-9 rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 text-sm"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
            >
              <option value="friendly">friendly</option>
              <option value="direct">direct</option>
              <option value="formal">formal</option>
            </select>
          </div>

          {!selected ? (
            <div className="mt-4 text-sm text-zinc-500">Select an action to draft a DM/reply.</div>
          ) : (
            <>
              <div className="mt-3 text-sm text-zinc-200 font-medium">{selected.community_name || selected.entity_key}</div>
              <div className="mt-1 text-xs text-zinc-500">{selected.ai_summary || selected.reason || "—"}</div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="h-9 rounded-lg bg-emerald-500 text-zinc-950 px-3 text-sm font-medium hover:bg-emerald-400"
                  onClick={async () => {
                    setDraftStatus("loading");
                    setDraftError("");
                    try {
                      const out = await apiFetch<{ ok: boolean; draft: string }>("/api/copilot/draft-dm", {
                        method: "POST",
                        body: JSON.stringify({
                          entity_key: selected.entity_key,
                          tone,
                          context: selected.reason || "",
                        }),
                      });
                      setDraft(out.draft || "");
                      setDraftStatus("idle");
                    } catch (err: any) {
                      setDraftStatus("error");
                      setDraftError(err?.message || "Draft failed");
                    }
                  }}
                >
                  Draft DM
                </button>
                <button
                  className="h-9 rounded-lg border border-zinc-800 px-3 text-sm hover:bg-zinc-900"
                  onClick={async () => {
                    setDraftStatus("loading");
                    setDraftError("");
                    try {
                      const out = await apiFetch<{ ok: boolean; draft: string }>("/api/copilot/draft-reply", {
                        method: "POST",
                        body: JSON.stringify({
                          entity_key: selected.entity_key,
                          tone,
                          context: selected.reason || "",
                        }),
                      });
                      setDraft(out.draft || "");
                      setDraftStatus("idle");
                    } catch (err: any) {
                      setDraftStatus("error");
                      setDraftError(err?.message || "Draft failed");
                    }
                  }}
                >
                  Draft Reply
                </button>
              </div>

              {draftError ? <div className="mt-3 text-sm text-rose-300">{draftError}</div> : null}

              <textarea
                className="mt-3 w-full rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 py-2 text-sm"
                rows={10}
                placeholder={draftStatus === "loading" ? "Drafting…" : "Draft will appear here"}
                value={draft}
                readOnly
              />
            </>
          )}
        </div>
      </div>

      <div className="mt-3 text-xs text-zinc-500">
        Copilot is advisory only. It never sends messages.
      </div>
    </div>
  );
}

