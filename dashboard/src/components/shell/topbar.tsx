'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Search, PlugZap } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { loadIntelSettings } from '@/lib/settings';

export function Topbar() {
  const [connected, setConnected] = useState(false);
  const [base, setBase] = useState<string | null>(null);

  useEffect(() => {
    const s = loadIntelSettings();
    setConnected(!!s);
    setBase(s?.apiBaseUrl || null);
  }, []);

  const label = useMemo(() => {
    if (!connected) return 'Not connected';
    try {
      const u = new URL(base || '');
      return u.host;
    } catch {
      return base || 'Connected';
    }
  }, [connected, base]);

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/70 backdrop-blur">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="relative flex-1 max-w-[560px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search communities, posts, runs…"
            className="pl-9 bg-panel/40"
            onChange={() => {
              // reserved for future global search
            }}
          />
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={connected ? 'success' : 'warning'}>{label}</Badge>
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-panel/40 px-3 py-2 text-sm hover:bg-muted"
          >
            <PlugZap className="h-4 w-4" />
            Settings
          </Link>
        </div>
      </div>
    </header>
  );
}

