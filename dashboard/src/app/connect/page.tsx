'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { defaultIntelBaseUrl } from '@/lib/authStorage';
import { useAuthStore } from '@/lib/authStore';

async function validate({ apiBaseUrl, apiKey }: { apiBaseUrl: string; apiKey: string }) {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/api/intel/health`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store' });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${r.status}`;
    throw new Error(String(msg));
  }
  return data;
}

export default function ConnectPage() {
  const router = useRouter();
  const { auth, connect, hydrate } = useAuthStore();

  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(defaultIntelBaseUrl());
  const [remember, setRemember] = useState(true);
  const [pasted, setPasted] = useState(false);

  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (auth) router.replace('/overview');
  }, [auth, router]);

  const canSubmit = useMemo(() => !!apiKey.trim() && !!baseUrl.trim() && !loading, [apiKey, baseUrl, loading]);

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4 py-10">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(96,165,250,0.18),transparent_45%),radial-gradient(circle_at_bottom,rgba(34,197,94,0.12),transparent_48%)]" />
        <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(to_right,rgba(148,163,184,.55)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,.55)_1px,transparent_1px)] [background-size:48px_48px]" />
      </div>

      <div className="relative w-full max-w-[460px]">
        <Card className="shadow-[0_30px_120px_rgba(0,0,0,.35)]">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="h-10 w-10 rounded-2xl border border-border bg-muted/40 flex items-center justify-center">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle>Connect to Kickchain Intelligence</CardTitle>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Enter your workspace API key to access your intelligence dashboard.
                  </div>
                </div>
              </div>
              {ok ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="muted">Secure access</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Workspace API Key</div>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setOk(false);
                      setError('');
                    }}
                    onPaste={() => {
                      setPasted(true);
                      setTimeout(() => setPasted(false), 1200);
                    }}
                    placeholder="kc_user_… or kc_live_…"
                    className="pl-9 bg-panel/40"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Bearer token for your workspace.</span>
                  {pasted ? <span className="text-success">Pasted</span> : null}
                </div>
              </div>

              <details className="rounded-xl border border-border bg-muted/20 px-3 py-2">
                <summary className="cursor-pointer text-sm text-muted-foreground select-none">
                  Advanced
                </summary>
                <div className="mt-3">
                  <div className="text-xs text-muted-foreground mb-1">API Base URL</div>
                  <Input
                    value={baseUrl}
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      setOk(false);
                      setError('');
                    }}
                    placeholder="https://kickchain-growth-backend.vercel.app"
                    className="bg-panel/40"
                  />
                  <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      className="h-4 w-4 accent-[var(--primary)]"
                    />
                    Remember this device
                  </label>
                </div>
              </details>

              {error ? (
                <div className="rounded-xl border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {error}
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={!canSubmit}
                  onClick={async () => {
                    setLoading(true);
                    setError('');
                    setOk(false);
                    try {
                      const apiBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
                      const apiKeyTrimmed = String(apiKey || '').trim();
                      await validate({ apiBaseUrl, apiKey: apiKeyTrimmed });
                      connect({ apiBaseUrl, apiKey: apiKeyTrimmed, remember });
                      setOk(true);
                      router.replace('/overview');
                    } catch (e: any) {
                      setError(e?.message || 'Failed to connect');
                    } finally {
                      setLoading(false);
                    }
                  }}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Validating…
                    </>
                  ) : (
                    'Connect'
                  )}
                </Button>
              </div>

              <div className="text-xs text-muted-foreground">
                Test Connection indicator appears after successful validation.
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="mt-4 text-center text-xs text-muted-foreground">
          Internal operator console • Kickchain Intelligence
        </div>
      </div>
    </div>
  );
}

