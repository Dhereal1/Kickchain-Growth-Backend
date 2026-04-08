'use client';

import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { RightPanel, RightPanelProvider } from './right-panel';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <RightPanelProvider>
      <div className="flex min-h-screen bg-background text-foreground">
        <Sidebar />
        <div className="flex-1 min-w-0 flex flex-col">
          <Topbar />
          <main className="flex-1 min-w-0">
            <div className="mx-auto w-full max-w-[1400px] px-4 py-5">{children}</div>
          </main>
        </div>
        <RightPanel />
      </div>
    </RightPanelProvider>
  );
}

