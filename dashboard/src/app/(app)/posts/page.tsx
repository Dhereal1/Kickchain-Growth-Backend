'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NotConnected } from '@/components/empty';
import { usePosts } from '@/lib/queries';

export default function PostsPage() {
  const [minIntent, setMinIntent] = useState(1);
  const [q, setQ] = useState('');
  const posts = usePosts(100, minIntent);

  const notConnected = (posts.error as any)?.message?.includes('Not connected');
  if (notConnected) return <NotConnected />;

  const filtered = useMemo(() => {
    const items = posts.data?.items || [];
    const query = q.trim().toLowerCase();
    if (!query) return items;
    return items.filter((p: any) => String(p.text || '').toLowerCase().includes(query));
  }, [posts.data, q]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs text-muted-foreground">Signals feed</div>
          <h1 className="text-xl font-semibold tracking-tight">Posts</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-[220px]">
            <Input placeholder="Search text…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Min intent
            <Input
              type="number"
              min={0}
              max={10}
              value={minIntent}
              onChange={(e) => setMinIntent(Number(e.target.value || 0))}
              className="w-[84px]"
            />
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>High-signal posts</CardTitle>
            <Badge variant="muted">{posts.isLoading ? 'Loading…' : `${filtered.length} items`}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {filtered.map((p: any) => (
              <div key={`${p.platform}:${p.post_id}`} className="rounded-2xl border border-border bg-muted/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    {p.platform} • {p.community_name}
                  </div>
                  <div className="flex items-center gap-1">
                    <Badge variant={p.intent_score >= 5 ? 'success' : 'muted'}>intent {p.intent_score}</Badge>
                    <Badge variant="muted">eng {p.engagement_score}</Badge>
                  </div>
                </div>
                <div className="mt-2 whitespace-pre-wrap text-sm leading-6">
                  {String(p.text || '').slice(0, 600) || <span className="text-muted-foreground">(no text)</span>}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {p.posted_at ? new Date(p.posted_at).toLocaleString() : new Date(p.ingested_at).toLocaleString()}
                </div>
              </div>
            ))}
            {!filtered.length && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No posts match. Try lowering min intent or run the pipeline.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

