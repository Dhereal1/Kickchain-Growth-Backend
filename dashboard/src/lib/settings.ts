export type IntelSettings = {
  apiBaseUrl: string; // e.g. https://kickchain-growth-backend.vercel.app
  apiKey: string; // Bearer token (intel user key or admin key)
};

const KEY = 'kc_intel_settings_v1';

export function loadIntelSettings(): IntelSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IntelSettings>;
    const apiBaseUrl = String(parsed.apiBaseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(parsed.apiKey || '').trim();
    if (!apiBaseUrl || !apiKey) return null;
    return { apiBaseUrl, apiKey };
  } catch {
    return null;
  }
}

export function saveIntelSettings(next: IntelSettings) {
  if (typeof window === 'undefined') return;
  const apiBaseUrl = String(next.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(next.apiKey || '').trim();
  window.localStorage.setItem(KEY, JSON.stringify({ apiBaseUrl, apiKey }));
}

export function clearIntelSettings() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(KEY);
}

export function normalizeApiBaseUrl(input: string) {
  let v = String(input || '').trim();
  if (!v) return '';
  v = v.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v;
}

