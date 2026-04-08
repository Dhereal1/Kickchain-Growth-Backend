'use client';

export type IntelAuth = {
  apiBaseUrl: string;
  apiKey: string;
  updatedAt: number;
};

const KEY = 'kc_intel_auth_v1';
const LEGACY_KEY = 'kc_intel_settings_v1';

function safeJsonParse(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeBaseUrl(input: string) {
  let v = String(input || '').trim();
  if (!v) return '';
  v = v.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v;
}

function readFrom(storage: Storage | undefined) {
  if (!storage) return null;
  const parsed = safeJsonParse(storage.getItem(KEY));
  if (parsed && typeof parsed === 'object') return parsed as Partial<IntelAuth>;
  return null;
}

function readLegacy(storage: Storage | undefined) {
  if (!storage) return null;
  const parsed = safeJsonParse(storage.getItem(LEGACY_KEY));
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as any;
}

export function loadIntelAuth(): IntelAuth | null {
  if (typeof window === 'undefined') return null;

  const session = readFrom(window.sessionStorage);
  const local = readFrom(window.localStorage);
  const legacy = readLegacy(window.localStorage) || readLegacy(window.sessionStorage);

  const raw: any = session || local || null;

  const apiBaseUrl = normalizeBaseUrl(
    (raw && raw.apiBaseUrl) || (legacy && legacy.apiBaseUrl) || ''
  );
  const apiKey = String((raw && raw.apiKey) || (legacy && legacy.apiKey) || '').trim();
  const updatedAt = Number((raw && raw.updatedAt) || Date.now()) || Date.now();

  if (!apiBaseUrl || !apiKey) return null;
  return { apiBaseUrl, apiKey, updatedAt };
}

export function saveIntelAuth(auth: { apiBaseUrl: string; apiKey: string }, remember = false) {
  if (typeof window === 'undefined') return;
  const apiBaseUrl = normalizeBaseUrl(auth.apiBaseUrl);
  const apiKey = String(auth.apiKey || '').trim();
  if (!apiBaseUrl || !apiKey) return;

  const payload: IntelAuth = { apiBaseUrl, apiKey, updatedAt: Date.now() };

  window.sessionStorage.setItem(KEY, JSON.stringify(payload));
  if (remember) window.localStorage.setItem(KEY, JSON.stringify(payload));
  if (!remember) window.localStorage.removeItem(KEY);
}

export function clearIntelAuth() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(KEY);
  window.localStorage.removeItem(KEY);
}

export function defaultIntelBaseUrl() {
  return 'https://kickchain-growth-backend.vercel.app';
}

