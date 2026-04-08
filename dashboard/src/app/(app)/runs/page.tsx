'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NotConnected } from '@/components/empty';
import { useRuns } from '@/lib/queries';
import { useRightPanel } from '@/components/shell/right-panel';

export default function RunsPage() {
  const runs = useRuns();
  const { setPanel } = useRightPanel();

  const notConnected = (runs.error as any)?.message?.includes('Not connected');
  if (notConnected) return <NotConnected />;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">Dev + ops visibility</div>
          <h1 className="text-xl font-semibold tracking-tight">Pipeline Runs</h1>
        </div>
        <Badge variant="muted">
          success rate {Number(runs.data?.success_rate ?? 0).toFixed(2)} • avg {runs.data?.avg_duration_ms ?? 0}ms
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Last 5 runs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-3 pr-4 text-left font-medium">Run ID</th>
                  <th className="py-3 pr-4 text-left font-medium">Status</th>
                  <th className="py-3 pr-4 text-right font-medium">Duration</th>
                  <th className="py-3 pr-4 text-right font-medium">Fetched</th>
                  <th className="py-3 pr-4 text-right font-medium">Inserted</th>
                  <th className="py-3 pr-4 text-right font-medium">Deduped</th>
                  <th className="py-3 pr-4 text-left font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {(runs.data?.last_5_runs || []).map((r: any) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/60 hover:bg-muted/50 cursor-pointer"
                    onClick={() =>
                      setPanel({
                        title: `Run #${r.id}`,
                        content: (
                          <div className="space-y-3">
                            <div className="text-sm font-semibold">Run details</div>
                            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                              <div>Status: {r.status}</div>
                              <div>Platform: {r.platform || '—'}</div>
                              <div>Datasets: {Array.isArray(r.datasets) ? r.datasets.length : '—'}</div>
                              <div>Duration: {r.duration_ms}ms</div>
                              <div>Fetched: {r.fetched_items}</div>
                              <div>Inserted: {r.inserted_posts}</div>
                              <div>Deduped: {r.deduped_posts}</div>
                              <div>Communities: {r.communities_updated}</div>
                            </div>
                            {r.error_message && (
                              <div className="rounded-xl border border-border bg-muted/40 p-3">
                                <div className="text-xs text-muted-foreground">Error</div>
                                <div className="mt-1 text-sm">{r.error_message}</div>
                              </div>
                            )}
                          </div>
                        ),
                      })
                    }
                  >
                    <td className="py-3 pr-4 font-mono text-xs">#{r.id}</td>
                    <td className="py-3 pr-4">
                      <Badge variant={r.status === 'success' ? 'success' : r.status === 'failed' ? 'danger' : 'muted'}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums">{r.duration_ms}ms</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{r.fetched_items}</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{r.inserted_posts}</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{r.deduped_posts}</td>
                    <td className="py-3 pr-4 text-xs text-muted-foreground">
                      {r.run_at ? new Date(r.run_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
                {!runs.data?.last_5_runs?.length && (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      No runs yet. Trigger `/api/cron/intel-full-pipeline` or `/api/intel/sync-communities`.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

