"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { CommunityCard, type PipelineCommunity } from "@/components/growth/community-card";
import { OutreachHistoryDrawer } from "@/components/growth/outreach-history-drawer";

type CommunitiesResponse = { ok: boolean; items: PipelineCommunity[] };

const STAGES = ["discovered", "engaging", "warm", "activated", "partner"] as const;

export default function GrowthCommunitiesPage() {
  const [items, setItems] = useState<PipelineCommunity[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  const [active, setActive] = useState<PipelineCommunity | null>(null);

  async function load() {
    setStatus("loading");
    setError("");
    try {
      const out = await apiFetch<CommunitiesResponse>("/api/growth/communities?limit=200");
      setItems(Array.isArray(out.items) ? out.items : []);
      setStatus("idle");
    } catch (err: any) {
      setStatus("error");
      setError(err?.message || "Failed to load");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const byStage = useMemo(() => {
    const map: Record<string, PipelineCommunity[]> = {};
    for (const s of STAGES) map[s] = [];
    for (const it of items) {
      const s = String(it.stage || "discovered").toLowerCase();
      (map[s] || (map[s] = [])).push(it);
    }
    for (const s of Object.keys(map)) {
      map[s].sort((a, b) => Number(b.computed_opportunity_score ?? b.opportunity_score) - Number(a.computed_opportunity_score ?? a.opportunity_score));
    }
    return map;
  }, [items]);

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-400">Communities pipeline</div>
          <h1 className="text-lg font-semibold tracking-tight">Growth CRM</h1>
        </div>
        <div className="flex items-center gap-2">
          <button className="text-xs rounded-md border border-zinc-800 px-2 py-1 hover:bg-zinc-900" onClick={load}>
            Refresh
          </button>
          <div className="text-xs text-zinc-400">{status === "loading" ? "Loading…" : `${items.length} items`}</div>
        </div>
      </div>

      {error ? <div className="mt-4 text-sm text-rose-300">{error}</div> : null}

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-5 gap-3">
        {STAGES.map((stage) => (
          <div key={stage} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500 uppercase tracking-wide">{stage}</div>
            <div className="mt-2 grid gap-2">
              {(byStage[stage] || []).length ? (
                (byStage[stage] || []).map((it) => <CommunityCard key={it.id} item={it} onOpen={(x) => setActive(x)} />)
              ) : (
                <div className="text-xs text-zinc-500">No items</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <OutreachHistoryDrawer
        open={!!active}
        item={active}
        onClose={() => setActive(null)}
        onStageChange={async (stage) => {
          if (!active) return;
          await apiFetch("/api/growth/community/update", {
            method: "POST",
            body: JSON.stringify({
              community_name: active.community_name,
              stage,
              last_touch_at: new Date().toISOString(),
            }),
          });
          await load();
        }}
      />
    </div>
  );
}

