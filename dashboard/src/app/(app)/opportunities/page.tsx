'use client';

import { useMemo, useState } from 'react';
import { TrendingUp, Zap, Flame, ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NotConnected } from '@/components/empty';
import { useOpportunities } from '@/lib/queries';
import { useRightPanel } from '@/components/shell/right-panel';
import { cn } from '@/lib/cn';

type Filter = 'all' | 'high_intent' | 'trending' | 'promo_heavy' | 'high_activity';

function meterVariant(value: number) {
  if (value >= 0.75) return 'success';
  if (value >= 0.4) return 'warning';
  return 'muted';
}

export default function OpportunitiesPage() {
  const opp = useOpportunities();
  const { setPanel } = useRightPanel();
  const [filter, setFilter] = useState<Filter>('all');

  const notConnected = (opp.error as any)?.message?.includes('Not connected');
  if (notConnected) return <NotConnected />;

  const rows = useMemo(() => {
    const o = opp.data?.opportunities;
    if (!o) return [];

    const buckets: Array<[Filter, any[]]> = [
      ['high_intent', o.high_intent || []],
      ['high_activity', o.high_activity || []],
      ['promo_heavy', o.promo_heavy || []],
      ['trending', o.trending || []],
    ];

    const merged = new Map<string, any>();
    for (const [kind, list] of buckets) {
      for (const item of list) {
        const key = `${item.platform}:${item.name}`;
        const prev = merged.get(key);
        merged.set(key, {
          ...prev,
          ...item,
          _kinds: Array.from(new Set([...(prev?._kinds || []), kind])),
        });
      }
    }
    const out = Array.from(merged.values());
    out.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    return out;
  }, [opp.data]);

  const filtered = useMemo(() => {
    if (filter === 'all') return rows;
    return rows.filter((r) => (r._kinds || []).includes(filter));
  }, [rows, filter]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">Where growth decisions happen</div>
          <h1 className="text-xl font-semibold tracking-tight">Opportunities</h1>
        </div>
        <div className="flex items-center gap-2">
          {(['all', 'high_intent', 'trending', 'high_activity', 'promo_heavy'] as Filter[]).map((f) => (
            <button
              key={f}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs transition-colors',
                filter === f ? 'bg-muted text-foreground border-border' : 'text-muted-foreground hover:bg-muted'
              )}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Ranked opportunities</CardTitle>
            <Badge variant="muted">
              {opp.isLoading ? 'Loading…' : `${filtered.length} items`}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-3 pr-4 text-left font-medium">Community</th>
                  <th className="py-3 pr-4 text-left font-medium">Platform</th>
                  <th className="py-3 pr-4 text-right font-medium">Activity</th>
                  <th className="py-3 pr-4 text-right font-medium">Intent</th>
                  <th className="py-3 pr-4 text-right font-medium">Engagement</th>
                  <th className="py-3 pr-4 text-right font-medium">Trend</th>
                  <th className="py-3 pr-4 text-right font-medium">Confidence</th>
                  <th className="py-3 pr-4 text-right font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const confidence = Number(r.confidence_score || 0);
                  return (
                    <tr
                      key={`${r.platform}:${r.name}`}
                      className="border-b border-border/60 hover:bg-muted/50 cursor-pointer"
                      onClick={() =>
                        setPanel({
                          title: r.name,
                          content: (
                            <div className="space-y-4">
                              <div className="flex items-center justify-between">
                                <div>
                                  <div className="text-sm font-semibold">{r.name}</div>
                                  <div className="text-xs text-muted-foreground">{r.platform}</div>
                                </div>
                                <Badge variant="primary">{Number(r.score || 0).toFixed(1)}</Badge>
                              </div>

                              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                                <div className="flex items-center gap-2">
                                  <Flame className="h-4 w-4 text-warning" /> Activity: {r.activity_score}
                                </div>
                                <div className="flex items-center gap-2">
                                  <Zap className="h-4 w-4 text-success" /> Intent: {r.intent_score}
                                </div>
                                <div className="flex items-center gap-2">
                                  <ArrowUpRight className="h-4 w-4 text-primary" /> Engagement: {r.engagement_score}
                                </div>
                                <div className="flex items-center gap-2">
                                  <TrendingUp className="h-4 w-4 text-muted-foreground" /> Trend: {r.trend_score}
                                </div>
                              </div>

                              <div className="rounded-xl border border-border bg-muted/40 p-3">
                                <div className="text-xs text-muted-foreground">Why this is ranked high</div>
                                <div className="mt-1 text-sm">
                                  This community is scoring due to a combination of activity and intent signals. Validate
                                  context with recent posts before engaging.
                                </div>
                              </div>
                            </div>
                          ),
                        })
                      }
                    >
                      <td className="py-3 pr-4">
                        <div className="font-semibold">{r.name}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(r._kinds || []).slice(0, 3).map((k: string) => (
                            <Badge key={k} variant="muted" className="capitalize">
                              {k.replace('_', ' ')}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">{r.platform}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{r.activity_score ?? '—'}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{r.intent_score ?? '—'}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{r.engagement_score ?? '—'}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{r.trend_score ?? '—'}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">
                        <Badge variant={meterVariant(confidence)}>{confidence.toFixed(2)}</Badge>
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums font-semibold">{Number(r.score || 0).toFixed(1)}</td>
                    </tr>
                  );
                })}
                {!filtered.length && (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      No opportunities yet. Run the pipeline and verify your datasets.
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

