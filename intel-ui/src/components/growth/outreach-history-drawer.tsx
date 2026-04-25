"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { PipelineCommunity } from "./community-card";

type OutreachEvent = {
  id: number;
  entity_type: string;
  entity_key: string;
  channel: string;
  status: string;
  notes?: string | null;
  created_at: string;
};

function entityKeyForCommunity(name: string) {
  const n = String(name || "").trim().toLowerCase();
  return n ? `telegram:${n.startsWith("@") ? n : `@${n}`}` : "";
}

export function OutreachHistoryDrawer({
  open,
  item,
  onClose,
  onStageChange,
}: {
  open: boolean;
  item: PipelineCommunity | null;
  onClose: () => void;
  onStageChange: (stage: string) => Promise<void>;
}) {
  const [events, setEvents] = useState<OutreachEvent[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const [logChannel, setLogChannel] = useState("telegram");
  const [logStatus, setLogStatus] = useState("sent");

  const entityKey = useMemo(() => (item ? entityKeyForCommunity(item.community_name) : ""), [item]);

  useEffect(() => {
    if (!open || !entityKey) return;
    let alive = true;
    (async () => {
      setStatus("loading");
      setError("");
      try {
        const out = await apiFetch<{ ok: boolean; items: OutreachEvent[] }>(
          `/api/growth/outreach?entity_key=${encodeURIComponent(entityKey)}&limit=50`
        );
        if (!alive) return;
        setEvents(Array.isArray(out.items) ? out.items : []);
        setStatus("idle");
      } catch (err: any) {
        if (!alive) return;
        setStatus("error");
        setError(err?.message || "Failed to load outreach history");
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, entityKey]);

  if (!open || !item) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-lg border-l border-zinc-800 bg-zinc-950">
        <div className="p-4 border-b border-zinc-800 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs text-zinc-400">Outreach</div>
            <div className="font-semibold truncate">{item.community_name}</div>
            <div className="text-xs text-zinc-500 truncate">{entityKey}</div>
          </div>
          <button className="text-xs rounded-md border border-zinc-800 px-2 py-1 hover:bg-zinc-900" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="p-4 grid gap-4 overflow-auto h-[calc(100%-64px)]">
          <div className="rounded-xl border border-zinc-800 p-3 bg-zinc-950">
            <div className="text-xs text-zinc-400">Stage</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {["discovered", "engaging", "warm", "activated", "partner"].map((s) => (
                <button
                  key={s}
                  className="text-xs rounded-lg border border-zinc-800 px-2.5 py-1 hover:bg-zinc-900"
                  onClick={async () => {
                    setStatus("saving");
                    try {
                      await onStageChange(s);
                      setStatus("idle");
                    } catch (err: any) {
                      setStatus("error");
                      setError(err?.message || "Stage update failed");
                    }
                  }}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
            {status === "saving" ? <div className="mt-2 text-xs text-zinc-500">Saving…</div> : null}
          </div>

          <div className="rounded-xl border border-zinc-800 p-3 bg-zinc-950">
            <div className="text-xs text-zinc-400">Log outreach</div>
            <div className="mt-2 grid gap-2">
              <div className="grid grid-cols-2 gap-2">
                <select
                  className="h-10 rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 text-sm"
                  value={logChannel}
                  onChange={(e) => setLogChannel(e.target.value)}
                >
                  <option value="telegram">telegram</option>
                  <option value="twitter">twitter</option>
                  <option value="email">email</option>
                  <option value="other">other</option>
                </select>
                <select
                  className="h-10 rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 text-sm"
                  value={logStatus}
                  onChange={(e) => setLogStatus(e.target.value)}
                >
                  <option value="drafted">drafted</option>
                  <option value="sent">sent</option>
                  <option value="replied">replied</option>
                  <option value="ignored">ignored</option>
                </select>
              </div>
              <textarea
                className="w-full rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 py-2 text-sm"
                rows={3}
                placeholder="Notes (optional)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <button
                className="h-10 rounded-lg bg-emerald-500 text-zinc-950 px-3 text-sm font-medium hover:bg-emerald-400"
                onClick={async () => {
                  setStatus("saving");
                  setError("");
                  try {
                    const out = await apiFetch<{ ok: boolean; item: OutreachEvent }>("/api/growth/outreach/log", {
                      method: "POST",
                      body: JSON.stringify({
                        entity_type: "community",
                        entity_key: entityKey,
                        channel: logChannel,
                        status: logStatus,
                        notes: notes || null,
                      }),
                    });
                    setEvents((prev) => [out.item, ...prev]);
                    setNotes("");
                    setStatus("idle");
                  } catch (err: any) {
                    setStatus("error");
                    setError(err?.message || "Failed to log outreach");
                  }
                }}
              >
                Log
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 p-3 bg-zinc-950">
            <div className="text-xs text-zinc-400">History</div>
            {error ? <div className="mt-2 text-sm text-rose-300">{error}</div> : null}
            <div className="mt-2 grid gap-2">
              {events.length ? (
                events.map((e) => (
                  <div key={e.id} className="rounded-lg border border-zinc-800 p-2 bg-zinc-900/20">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-zinc-300">
                        {e.channel} · {e.status}
                      </div>
                      <div className="text-xs text-zinc-500">{String(e.created_at || "").slice(0, 19).replace("T", " ")}</div>
                    </div>
                    {e.notes ? <div className="mt-1 text-xs text-zinc-500">{e.notes}</div> : null}
                  </div>
                ))
              ) : (
                <div className="text-xs text-zinc-500">No outreach logged yet.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

