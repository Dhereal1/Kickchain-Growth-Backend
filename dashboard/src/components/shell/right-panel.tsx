'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';

type PanelState = {
  title?: string;
  content: React.ReactNode | null;
};

type PanelApi = {
  panel: PanelState;
  setPanel: (next: PanelState) => void;
  clear: () => void;
};

const Ctx = createContext<PanelApi | null>(null);

export function RightPanelProvider({ children }: { children: React.ReactNode }) {
  const [panel, setPanelState] = useState<PanelState>({ content: null });

  const api = useMemo<PanelApi>(
    () => ({
      panel,
      setPanel: (next) => setPanelState(next),
      clear: () => setPanelState({ content: null }),
    }),
    [panel]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useRightPanel() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRightPanel must be used within RightPanelProvider');
  return v;
}

export function RightPanel() {
  const { panel } = useRightPanel();

  return (
    <aside
      className={cn(
        'hidden xl:flex xl:w-[360px] flex-col border-l border-border bg-panel/60',
        panel.content ? '' : 'opacity-70'
      )}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="text-sm font-semibold tracking-tight">
          {panel.title || 'Details'}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {panel.content || (
          <div className="text-sm text-muted-foreground">
            Select an item to see context, posts, and “why this matters”.
          </div>
        )}
      </div>
    </aside>
  );
}

