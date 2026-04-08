'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NotConnected } from '@/components/empty';
import { useCreateWebhook, useDeliveries, useWebhooks } from '@/lib/queries';

export default function AlertsPage() {
  const webhooks = useWebhooks();
  const deliveries = useDeliveries(100);
  const createHook = useCreateWebhook();

  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');

  const notConnected =
    (webhooks.error as any)?.message?.includes('Not connected') ||
    (deliveries.error as any)?.message?.includes('Not connected');
  if (notConnected) return <NotConnected />;

  const recentFailures = useMemo(() => {
    const items = deliveries.data?.items || [];
    return items.filter((x: any) => x.status !== 'success').slice(0, 10);
  }, [deliveries.data]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">Delivery visibility + client outputs</div>
          <h1 className="text-xl font-semibold tracking-tight">Alerts & Webhooks</h1>
        </div>
        <Badge variant={recentFailures.length ? 'warning' : 'success'}>
          {recentFailures.length ? `${recentFailures.length} recent failures` : 'Deliveries healthy'}
        </Badge>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-1">
          <CardHeader>
            <CardTitle>Create webhook</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Name (optional)</div>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily Intel Report" />
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">URL</div>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhook" />
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Secret (optional)</div>
                <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="shared secret header" />
              </div>
              <Button
                variant="primary"
                disabled={createHook.isPending || !url.trim()}
                onClick={async () => {
                  await createHook.mutateAsync({ url: url.trim(), name: name.trim() || undefined, secret: secret.trim() || undefined });
                  setUrl('');
                  setName('');
                  setSecret('');
                }}
              >
                Save webhook
              </Button>
              {createHook.isError && (
                <div className="text-sm text-danger">{String((createHook.error as any)?.message || 'Failed')}</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <CardTitle>Webhooks</CardTitle>
              <Badge variant="muted">{webhooks.isLoading ? 'Loading…' : `${(webhooks.data?.items || []).length} total`}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {(webhooks.data?.items || []).map((h: any) => (
                <div key={h.id} className="rounded-2xl border border-border bg-muted/30 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{h.name || h.url}</div>
                      <div className="mt-1 text-xs text-muted-foreground break-all">{h.url}</div>
                    </div>
                    <Badge variant={h.enabled ? 'success' : 'muted'}>{h.enabled ? 'active' : 'disabled'}</Badge>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    last sent: {h.last_sent_at ? new Date(h.last_sent_at).toLocaleString() : '—'}
                  </div>
                </div>
              ))}
              {!((webhooks.data?.items || []).length) && (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  No webhooks registered yet.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Delivery logs</CardTitle>
            <Badge variant="muted">{deliveries.isLoading ? 'Loading…' : `${(deliveries.data?.items || []).length} entries`}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-3 pr-4 text-left font-medium">Status</th>
                  <th className="py-3 pr-4 text-right font-medium">Attempts</th>
                  <th className="py-3 pr-4 text-left font-medium">Webhook</th>
                  <th className="py-3 pr-4 text-left font-medium">Error</th>
                  <th className="py-3 pr-4 text-left font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {(deliveries.data?.items || []).map((d: any) => (
                  <tr key={d.id} className="border-b border-border/60 hover:bg-muted/50">
                    <td className="py-3 pr-4">
                      <Badge variant={d.status === 'success' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'}>
                        {d.status}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums">{d.attempts}</td>
                    <td className="py-3 pr-4">
                      <div className="text-sm font-semibold">{d.webhook_name || 'Webhook'}</div>
                      <div className="text-xs text-muted-foreground break-all">{d.webhook_url}</div>
                    </td>
                    <td className="py-3 pr-4 text-xs text-muted-foreground">
                      {d.last_error ? String(d.last_error).slice(0, 140) : '—'}
                    </td>
                    <td className="py-3 pr-4 text-xs text-muted-foreground">
                      {new Date(d.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {!((deliveries.data?.items || []).length) && (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                      No deliveries yet.
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

