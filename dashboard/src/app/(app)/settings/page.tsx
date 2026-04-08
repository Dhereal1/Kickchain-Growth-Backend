'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { defaultIntelBaseUrl, loadIntelAuth } from '@/lib/authStorage';
import { useAuthStore } from '@/lib/authStore';

export default function SettingsPage() {
  const { auth, connect, disconnect, hydrate } = useAuthStore();
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [remember, setRemember] = useState(true);
  const [status, setStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    hydrate();
    const s = loadIntelAuth();
    if (s) {
      setApiBaseUrl(s.apiBaseUrl);
      setApiKey(s.apiKey);
    }
    if (!s) setApiBaseUrl(defaultIntelBaseUrl());
  }, []);

  async function testConnection(nextBase: string, nextKey: string) {
    const base = String(nextBase || '').trim().replace(/\/+$/, '');
    const key = String(nextKey || '').trim();
    if (!base || !key) {
      setStatus('fail');
      setMessage('Missing base URL or key.');
      return;
    }
    try {
      const r = await fetch(`${base}/api/intel/health`, {
        headers: { Authorization: `Bearer ${key}` },
        cache: 'no-store',
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${r.status}`);
      setStatus('ok');
      setMessage('Connected.');
    } catch (err: any) {
      setStatus('fail');
      setMessage(err?.message || 'Failed to connect');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">Configure operator access</div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        </div>
        <Badge variant={status === 'ok' ? 'success' : status === 'fail' ? 'danger' : 'muted'}>
          {status === 'idle' ? 'Not tested' : status === 'ok' ? 'Connected' : 'Not connected'}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Intel API connection</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-muted-foreground mb-1">API Base URL</div>
              <Input
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="https://kickchain-growth-backend.vercel.app"
              />
              <div className="mt-2 text-xs text-muted-foreground">
                Use your deployed backend domain (not Hoppscotch).
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">API Key (Bearer)</div>
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="kc_user_… or kc_live_…"
              />
              <div className="mt-2 text-xs text-muted-foreground">
                Use an intel user key (`kc_user_…`) for tenant data, or admin key for admin-only actions.
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={async () => {
                const base = String(apiBaseUrl || '').trim().replace(/\/+$/, '');
                const key = String(apiKey || '').trim();
                connect({ apiBaseUrl: base, apiKey: key, remember });
                await testConnection(base, key);
              }}
            >
              Save + test
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                await testConnection(apiBaseUrl, apiKey);
              }}
            >
              Test
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                disconnect();
                setApiBaseUrl(defaultIntelBaseUrl());
                setApiKey('');
                setStatus('idle');
                setMessage('');
              }}
            >
              Clear
            </Button>
          </div>

          <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            Remember this device
          </label>

          {message && (
            <div className="mt-3 text-sm text-muted-foreground">
              {status === 'fail' ? <span className="text-danger">{message}</span> : message}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            <li>All endpoints are read-only except webhook creation and discovery refresh.</li>
            <li>
              Keys are stored in memory + session storage. If you enable “Remember”, they are also stored in local
              storage.
            </li>
            <li>Scraping is public-metadata only; no auto-messaging is implemented.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
