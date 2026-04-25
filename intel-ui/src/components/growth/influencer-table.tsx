"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";

type Influencer = {
  id: number;
  handle: string;
  platform: string;
  contact_status: string;
  deal_status: string;
  conversions: number;
  payout_total: string | number;
  notes?: string | null;
  updated_at?: string;
};

export function InfluencerTable() {
  const [rows, setRows] = useState<Influencer[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "error">("idle");
  const [error, setError] = useState("");

  const [handle, setHandle] = useState("");
  const [contactStatus, setContactStatus] = useState("new");
  const [dealStatus, setDealStatus] = useState("none");
  const [notes, setNotes] = useState("");

  const count = useMemo(() => rows.length, [rows]);

  async function refresh() {
    setStatus("loading");
    setError("");
    try {
      const out = await apiFetch<{ ok: boolean; items: Influencer[] }>("/api/growth/influencers?limit=100");
      setRows(Array.isArray(out.items) ? out.items : []);
      setStatus("idle");
    } catch (err: any) {
      setStatus("error");
      setError(err?.message || "Failed to load influencers");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-400">Influencer CRM</div>
          <h1 className="text-lg font-semibold tracking-tight">Influencers</h1>
        </div>
        <div className="text-xs text-zinc-400">{status === "loading" ? "Loading…" : `${count} rows`}</div>
      </div>

      {error ? <div className="mt-4 text-sm text-rose-300">{error}</div> : null}

      <div className="mt-4 rounded-xl border border-zinc-800 p-4 bg-zinc-950">
        <div className="text-xs text-zinc-500">Add / update influencer</div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2">
          <input
            className="h-10 rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 text-sm"
            placeholder="@handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
          <select
            className="h-10 rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 text-sm"
            value={contactStatus}
            onChange={(e) => setContactStatus(e.target.value)}
          >
            {["new", "contacted", "warm", "active", "paused"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            className="h-10 rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 text-sm"
            value={dealStatus}
            onChange={(e) => setDealStatus(e.target.value)}
          >
            {["none", "proposed", "signed", "paid"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            disabled={status === "saving"}
            className="h-10 rounded-lg bg-emerald-500 text-zinc-950 px-3 text-sm font-medium hover:bg-emerald-400 disabled:opacity-60"
            onClick={async () => {
              setStatus("saving");
              setError("");
              try {
                await apiFetch("/api/growth/influencer/update", {
                  method: "POST",
                  body: JSON.stringify({
                    handle,
                    contact_status: contactStatus,
                    deal_status: dealStatus,
                    notes: notes || null,
                  }),
                });
                setHandle("");
                setNotes("");
                await refresh();
                setStatus("idle");
              } catch (err: any) {
                setStatus("error");
                setError(err?.message || "Save failed");
              }
            }}
          >
            Save
          </button>
        </div>
        <textarea
          className="mt-2 w-full rounded-lg bg-zinc-900/40 border border-zinc-800 px-3 py-2 text-sm"
          rows={3}
          placeholder="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="mt-4 overflow-auto rounded-xl border border-zinc-800">
        <table className="min-w-[980px] w-full text-sm">
          <thead className="bg-zinc-950">
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
              <th className="py-3 px-3 font-medium">Handle</th>
              <th className="py-3 px-3 font-medium">Contact</th>
              <th className="py-3 px-3 font-medium">Deal</th>
              <th className="py-3 px-3 font-medium text-right">Conversions</th>
              <th className="py-3 px-3 font-medium text-right">Payout</th>
              <th className="py-3 px-3 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-zinc-900 hover:bg-zinc-900/30">
                <td className="py-3 px-3 font-medium text-zinc-100">{r.handle}</td>
                <td className="py-3 px-3 text-zinc-300">{r.contact_status}</td>
                <td className="py-3 px-3 text-zinc-300">{r.deal_status}</td>
                <td className="py-3 px-3 text-right tabular-nums text-zinc-300">{Number(r.conversions || 0)}</td>
                <td className="py-3 px-3 text-right tabular-nums text-zinc-300">{String(r.payout_total ?? "0")}</td>
                <td className="py-3 px-3 text-zinc-500 max-w-[420px] truncate">{r.notes || "—"}</td>
              </tr>
            ))}
            {!rows.length && status !== "loading" ? (
              <tr>
                <td colSpan={6} className="py-10 text-center text-zinc-500">
                  No influencers yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

