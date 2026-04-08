import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

export function NotConnected() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect to Intel API</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-sm text-muted-foreground">
          Set your API Base URL and API Key to load live intelligence.
        </div>
        <div className="mt-3">
          <Link
            href="/settings"
            className="inline-flex rounded-lg border border-border bg-muted px-3 py-2 text-sm hover:bg-muted/80"
          >
            Open Settings
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

