'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NotConnected } from '@/components/empty';
import { useCommunities } from '@/lib/queries';
import { useRightPanel } from '@/components/shell/right-panel';

export default function CommunitiesPage() {
  const [q, setQ] = useState('');
  const communities = useCommunities(200);
  const { setPanel } = useRightPanel();

  const notConnected = (communities.error as any)?.message?.includes('Not connected');
  if (notConnected) return <NotConnected />;

  const rows = useMemo(() => {
    const items = communities.data?.items || [];
    const query = q.trim().toLowerCase();
    if (!query) return items;
    return items.filter((x: any) => String(x.name || '').toLowerCase().includes(query));
  }, [communities.data, q]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">Full database view</div>
          <h1 className="text-xl font-semibold tracking-tight">Communities</h1>
        </div>
        <div className="w-full max-w-[420px]">
          <Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Tracked communities</CardTitle>
            <Badge variant="muted">{communities.isLoading ? 'Loading…' : `${rows.length} shown`}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-3 pr-4 text-left font-medium">Name</th>
                  <th className="py-3 pr-4 text-left font-medium">Platform</th>
                  <th className="py-3 pr-4 text-right font-medium">Members</th>
                  <th className="py-3 pr-4 text-right font-medium">Intent</th>
                  <th className="py-3 pr-4 text-right font-medium">Activity</th>
                  <th className="py-3 pr-4 text-right font-medium">Score</th>
                  <th className="py-3 pr-4 text-left font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c: any) => (
                  <tr
                    key={`${c.platform}:${c.name}`}
                    className="border-b border-border/60 hover:bg-muted/50 cursor-pointer"
                    onClick={() =>
                      setPanel({
                        title: c.name,
                        content: (
                          <div className="space-y-3">
                            <div className="text-sm font-semibold">Signal breakdown</div>
                            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                              <div>Member proxy: {c.member_count ?? 0}</div>
                              <div>Activity proxy: {c.activity_score ?? 0}</div>
                              <div>Intent: {c.intent_score ?? 0}</div>
                              <div>Engagement: {c.engagement_score ?? 0}</div>
                              <div>Promo: {c.promo_score ?? 0}</div>
                              <div>Content activity: {c.content_activity_score ?? 0}</div>
                            </div>
                            <div className="rounded-xl border border-border bg-muted/40 p-3">
                              <div className="text-xs text-muted-foreground">Why this matters</div>
                              <div className="mt-1 text-sm">
                                Use this view to validate whether you’re tracking real conversations vs broadcasts.
                              </div>
                            </div>
                          </div>
                        ),
                      })
                    }
                  >
                    <td className="py-3 pr-4">
                      <div className="font-semibold">{c.name}</div>
                      <div className="text-xs text-muted-foreground">updated {new Date(c.updated_at).toLocaleString()}</div>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">{c.platform}</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{c.member_count ?? '—'}</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{c.intent_score ?? '—'}</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{c.activity_score ?? '—'}</td>
                    <td className="py-3 pr-4 text-right tabular-nums font-semibold">{Number(c.score || 0).toFixed(1)}</td>
                    <td className="py-3 pr-4 text-xs text-muted-foreground">
                      {c.last_seen_at ? new Date(c.last_seen_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                      No communities yet. Run intel pipeline or discovery scrape to ingest data.
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

