'use client';

import { useMemo } from 'react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NotConnected } from '@/components/empty';
import { useCommunities, useHealth, useMetrics, useOpportunities } from '@/lib/queries';
import { useRightPanel } from '@/components/shell/right-panel';
import { Button } from '@/components/ui/button';

function formatDay(d: string) {
  try {
    return new Date(d).toISOString().slice(5, 10);
  } catch {
    return d;
  }
}

export default function OverviewPage() {
  const opp = useOpportunities();
  const health = useHealth();
  const metrics = useMetrics(7);
  const communities = useCommunities(200);
  const { setPanel } = useRightPanel();

  const notConnected =
    (opp.error as any)?.message?.includes('Not connected') ||
    (health.error as any)?.message?.includes('Not connected') ||
    (metrics.error as any)?.message?.includes('Not connected');

  const kpis = useMemo(() => {
    const totalOpp = opp.data?.summary?.total_opportunities ?? 0;
    const highIntent = opp.data?.opportunities?.high_intent?.length ?? 0;
    const hotPosts = opp.data?.opportunities?.hot_posts?.length ?? 0;
    const pipelineStatus = health.data?.status ?? 'unknown';
    return { totalOpp, highIntent, hotPosts, pipelineStatus };
  }, [opp.data, health.data]);

  if (notConnected) return <NotConnected />;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">Command Center</div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={kpis.pipelineStatus === 'healthy' ? 'success' : 'warning'}>
            Pipeline: {kpis.pipelineStatus}
          </Badge>
          <Button
            variant="secondary"
            onClick={() => {
              setPanel({
                title: 'Where to Act Now',
                content: (
                  <div className="space-y-3">
                    <div className="text-sm font-semibold">Quick Focus</div>
                    <div className="text-sm text-muted-foreground">
                      Aim for high intent + rising trend. Open Opportunities for ranked actions.
                    </div>
                    <ul className="text-sm list-disc pl-5 text-muted-foreground space-y-1">
                      <li>Pick 3 communities with intent signals</li>
                      <li>Engage manually (no automation)</li>
                      <li>Track outcomes and refine keywords</li>
                    </ul>
                  </div>
                ),
              });
            }}
          >
            Where to act now
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Total Active Communities</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold tracking-tight">
              {communities.isLoading ? '—' : (communities.data?.items?.length ?? 0)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Showing top {Math.min(200, communities.data?.items?.length ?? 0)} by score.
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>High-Intent Communities</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold tracking-tight">{kpis.highIntent}</div>
            <div className="mt-1 text-xs text-muted-foreground">Based on today’s scoring.</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>New Opportunities (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold tracking-tight">{kpis.totalOpp}</div>
            <div className="mt-1 text-xs text-muted-foreground">High intent + trends + hot posts.</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Hot Posts Feed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold tracking-tight">{kpis.hotPosts}</div>
            <div className="mt-1 text-xs text-muted-foreground">High-signal posts detected.</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <CardTitle>Activity vs Intent vs Engagement (7d)</CardTitle>
              <Badge variant="muted">Data-first</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={(metrics.data?.series || []).map((x) => ({ ...x, dayLabel: formatDay(x.day) }))}>
                  <XAxis dataKey="dayLabel" stroke="rgba(148,163,184,.6)" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="rgba(148,163,184,.35)" fontSize={12} tickLine={false} axisLine={false} width={32} />
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(15, 22, 41, 0.9)',
                      border: '1px solid rgba(148,163,184,.18)',
                      borderRadius: 12,
                      color: '#e5e7eb',
                    }}
                    labelStyle={{ color: '#e5e7eb' }}
                  />
                  <Line type="monotone" dataKey="activity" stroke="var(--primary)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="intent" stroke="var(--success)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="engagement" stroke="var(--warning)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top 5 Opportunities Today</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {(opp.data?.opportunities?.high_intent || []).slice(0, 5).map((c: any) => (
                <button
                  key={`${c.platform}:${c.name}`}
                  className="w-full text-left rounded-xl border border-border bg-muted/40 hover:bg-muted px-3 py-2"
                  onClick={() =>
                    setPanel({
                      title: c.name,
                      content: (
                        <div className="space-y-3">
                          <div className="text-sm font-semibold">Why this matters</div>
                          <div className="text-sm text-muted-foreground">
                            High intent + recent activity. Engage manually and validate community quality.
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                            <div>Intent: {c.intent_score}</div>
                            <div>Trend: {c.trend_score}</div>
                            <div>Engagement: {c.engagement_score}</div>
                            <div>Confidence: {Number(c.confidence_score || 0).toFixed(2)}</div>
                          </div>
                        </div>
                      ),
                    })
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">{c.name}</div>
                    <Badge variant="primary">{Number(c.score || 0).toFixed(1)}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {c.platform} • intent {c.intent_score} • trend {c.trend_score}
                  </div>
                </button>
              ))}
              {!opp.data?.opportunities?.high_intent?.length && (
                <div className="text-sm text-muted-foreground">No ranked opportunities yet.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
