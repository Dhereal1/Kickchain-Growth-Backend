import { loadIntelAuth } from './authStorage';

export type IntelOpportunitiesResponse = {
  summary: {
    total_opportunities: number;
    top_platform: string | null;
  };
  opportunities: {
    high_intent: any[];
    high_activity: any[];
    promo_heavy: any[];
    trending: any[];
    hot_posts: any[];
  };
  metadata: {
    generated_at: string;
    confidence_score: number;
  };
};

export type IntelRunsResponse = {
  success_rate: number;
  avg_duration_ms: number;
  avg_processing_time_ms: number;
  last_5_runs: any[];
};

function getAuthHeaders() {
  const s = loadIntelAuth();
  if (!s) throw new Error('Not connected. Go to /connect.');
  return { baseUrl: s.apiBaseUrl, headers: { Authorization: `Bearer ${s.apiKey}` } };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, headers } = getAuthHeaders();
  const url = `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
      ...headers,
    },
    cache: 'no-store',
  });

  const text = await r.text().catch(() => '');
  const data = text ? JSON.parse(text) : null;

  if (!r.ok) {
    const message = (data && (data.error || data.message)) || `HTTP ${r.status}`;
    const err = new Error(String(message));
    // @ts-expect-error attach metadata
    err.status = r.status;
    // @ts-expect-error attach metadata
    err.data = data;
    throw err;
  }
  return data as T;
}

export const intelApi = {
  opportunities: () => fetchJson<IntelOpportunitiesResponse>('/api/intel/opportunities'),
  today: () => fetchJson<{ top_communities: any[]; recommendations: string[] }>('/api/intel/today'),
  runsSummary: () => fetchJson<IntelRunsResponse>('/api/intel/runs'),
  health: () =>
    fetchJson<{ last_run: string | null; status: string; datasets_connected: number; last_ingest_count: number }>(
      '/api/intel/health'
    ),
  metrics: (days = 7) => fetchJson<{ ok: true; days: number; series: Array<{ day: string; activity: number; intent: number; engagement: number }> }>(
    `/api/intel/metrics?days=${encodeURIComponent(String(days))}`
  ),
  communities: (limit = 50) =>
    fetchJson<{ ok: true; items: any[] }>(`/api/intel/communities?limit=${encodeURIComponent(String(limit))}`),
  posts: (limit = 50, minIntent = 0) =>
    fetchJson<{ ok: true; items: any[] }>(
      `/api/intel/posts?limit=${encodeURIComponent(String(limit))}&min_intent=${encodeURIComponent(String(minIntent))}`
    ),
  discovered: () => fetchJson<any[]>('/api/intel/discovered-communities'),
  refreshDiscovered: () => fetchJson<any>('/api/intel/discovered-communities/refresh', { method: 'POST', body: '{}' }),
  webhooks: () => fetchJson<{ ok: true; items: any[] }>('/api/intel/webhooks'),
  deliveries: (limit = 50) =>
    fetchJson<{ ok: true; items: any[] }>(`/api/intel/webhook-deliveries?limit=${encodeURIComponent(String(limit))}`),
  createWebhook: (body: { url: string; name?: string; secret?: string; enabled?: boolean }) =>
    fetchJson<{ ok: boolean }>('/api/intel/webhook', { method: 'POST', body: JSON.stringify(body) }),
};
