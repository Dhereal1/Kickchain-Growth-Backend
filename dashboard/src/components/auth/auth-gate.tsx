'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/authStore';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { auth, hydrate, hydrated } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    if (auth) return;
    // Allow settings page to be accessible for connection troubleshooting.
    if (pathname === '/settings') return;
    router.replace('/connect');
  }, [auth, hydrated, pathname, router]);

  if (!hydrated) return null;
  if (!auth && pathname !== '/settings') return null;

  return <>{children}</>;
}

