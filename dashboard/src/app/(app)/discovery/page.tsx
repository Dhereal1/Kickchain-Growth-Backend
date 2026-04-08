'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NotConnected } from '@/components/empty';
import { useDiscovered, useRefreshDiscovered } from '@/lib/queries';

export default function DiscoveryPage() {
  const discovered = useDiscovered();
  const refresh = useRefreshDiscovered();
  const [busy, setBusy] = useState(false);

  const notConnected = (discovered.error as any)?.message?.includes('Not connected');
  if (notConnected) return <NotConnected />;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">Find new communities automatically</div>
          <h1 className="text-xl font-semibold tracking-tight">Discovery</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            disabled={refresh.isPending || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await refresh.mutateAsync();
              } finally {
                setBusy(false);
              }
            }}
          >
            Refresh (extract links)
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Ranked discovery list</CardTitle>
            <Badge variant="muted">{discovered.isLoading ? 'Loading…' : `${(discovered.data || []).length} items`}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <table className="min-w-[860px] w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-3 pr-4 text-left font-medium">Community</th>
                  <th className="py-3 pr-4 text-right font-medium">Discovery score</th>
                  <th className="py-3 pr-4 text-right font-medium">Total messages</th>
                  <th className="py-3 pr-4 text-right font-medium">Total intent</th>
                  <th className="py-3 pr-4 text-right font-medium">Avg intent</th>
                  <th className="py-3 pr-4 text-left font-medium">Category</th>
                </tr>
              </thead>
              <tbody>
                {(discovered.data || []).map((r: any) => (
                  <tr key={r.community} className="border-b border-border/60 hover:bg-muted/50">
                    <td className="py-3 pr-4">
                      <div className="font-semibold">{r.community}</div>
                      <div className="text-xs text-muted-foreground">{r.platform} • {String(r.day).slice(0, 10)}</div>
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums font-semibold">{Number(r.score || 0).toFixed(1)}</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{r.total_messages}</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{r.total_intent}</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{Number(r.avg_intent || 0).toFixed(2)}</td>
                    <td className="py-3 pr-4">
                      <Badge variant={r.category === 'high_value' ? 'success' : r.category === 'medium' ? 'warning' : 'muted'}>
                        {r.category}
                      </Badge>
                    </td>
                  </tr>
                ))}
                {!((discovered.data || []).length) && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      No discovered communities yet. Run discovery or ingest more posts so link extraction can find new groups.
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

