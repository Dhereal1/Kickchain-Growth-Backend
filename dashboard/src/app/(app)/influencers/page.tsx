import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function InfluencersPage() {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-muted-foreground">Partner discovery</div>
        <h1 className="text-xl font-semibold tracking-tight">Influencers</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming next</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Influencer detection requires linking identities across posts (author/usernames). Your current datasets don’t
            expose consistent author fields yet, so this page will stay in “design-ready” mode until the actor output
            includes authors.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

