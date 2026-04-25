"use client";

import { OpportunityScoreBadge } from "./opportunity-score-badge";

export type PipelineCommunity = {
  id: number;
  community_name: string;
  stage: string;
  opportunity_score: number;
  computed_opportunity_score?: number;
  notes?: string | null;
  intel?: {
    category?: string | null;
    ai?: { summary?: string | null; recommended_action?: string | null } | null;
  } | null;
};

function stageTone(stage: string) {
  const s = String(stage || "").toLowerCase();
  if (s === "partner") return "bg-fuchsia-500/10 border-fuchsia-500/25 text-fuchsia-200";
  if (s === "activated") return "bg-sky-500/10 border-sky-500/25 text-sky-200";
  if (s === "warm") return "bg-amber-500/10 border-amber-500/25 text-amber-200";
  if (s === "engaging") return "bg-emerald-500/10 border-emerald-500/25 text-emerald-200";
  return "bg-zinc-900/40 border-zinc-800 text-zinc-300";
}

export function CommunityCard({
  item,
  onOpen,
}: {
  item: PipelineCommunity;
  onOpen: (item: PipelineCommunity) => void;
}) {
  const score = typeof item.computed_opportunity_score === "number" ? item.computed_opportunity_score : item.opportunity_score;
  const aiSummary = item.intel?.ai?.summary || null;
  return (
    <button
      onClick={() => onOpen(item)}
      className="text-left rounded-xl border border-zinc-800 bg-zinc-950/60 hover:bg-zinc-900/40 p-3 transition"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-zinc-100 truncate">{item.community_name}</div>
          <div className="mt-1 text-xs text-zinc-500 truncate">{item.notes || aiSummary || "—"}</div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <OpportunityScoreBadge score={Number(score || 0)} />
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${stageTone(item.stage)}`}>
            {String(item.stage || "discovered").toUpperCase()}
          </span>
        </div>
      </div>
    </button>
  );
}

