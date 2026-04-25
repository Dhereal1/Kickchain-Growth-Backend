"use client";

export function OpportunityScoreBadge({ score }: { score: number }) {
  const s = Number(score || 0);
  const clamped = Math.max(0, Math.min(100, s));
  const tone =
    clamped >= 80
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/25"
      : clamped >= 55
        ? "bg-amber-500/15 text-amber-200 border-amber-500/25"
        : "bg-zinc-800/60 text-zinc-300 border-zinc-700";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums ${tone}`}
      title="Opportunity score (0–100)"
    >
      {clamped}
    </span>
  );
}

