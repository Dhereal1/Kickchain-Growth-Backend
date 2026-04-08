import { AppShell } from '@/components/shell/app-shell';
import { AuthGate } from '@/components/auth/auth-gate';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
