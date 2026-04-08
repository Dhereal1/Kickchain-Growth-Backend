'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Bell,
  CircleDot,
  Compass,
  Database,
  Flame,
  LayoutDashboard,
  Settings,
  Users,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/cn';

const nav = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard },
  { href: '/opportunities', label: 'Opportunities', icon: Flame },
  { href: '/communities', label: 'Communities', icon: Users },
  { href: '/influencers', label: 'Influencers', icon: CircleDot },
  { href: '/posts', label: 'Posts', icon: Activity },
  { href: '/discovery', label: 'Discovery', icon: Compass },
  { href: '/runs', label: 'Pipeline Runs', icon: Database },
  { href: '/alerts', label: 'Alerts & Webhooks', icon: Bell },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex lg:w-[260px] flex-col border-r border-border bg-panel/60">
      <div className="px-4 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center">
            <Wrench className="h-4 w-4 text-primary" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Kickchain</div>
            <div className="text-xs text-muted-foreground">Growth Intelligence</div>
          </div>
        </div>
      </div>

      <nav className="p-2 space-y-1">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto p-4 text-xs text-muted-foreground">
        <div>Control center for community growth.</div>
      </div>
    </aside>
  );
}

