const KEY_API_KEY = "kc_intel_api_key_v1";
const KEY_BASE_URL = "kc_intel_base_url_v1";

export function defaultBaseUrl() {
  const fromEnv = (process.env.NEXT_PUBLIC_INTEL_API_BASE_URL || "").trim();
  if (fromEnv) return fromEnv;

  // Avoid accidentally pointing at an old Vercel deployment. If running on a VPS where
  // intel-ui is served from :3001 and backend from :3004, infer the backend host.
  if (typeof window !== "undefined" && window.location) {
    const proto = window.location.protocol || "http:";
    const host = window.location.hostname || "localhost";
    return `${proto}//${host}:3004`;
  }

  return "http://localhost:3004";
}

export function getApiKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return String(localStorage.getItem(KEY_API_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function setApiKey(v: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY_API_KEY, String(v || "").trim());
  } catch {
    // ignore
  }
}

export function getBaseUrl(): string {
  if (typeof window === "undefined") return defaultBaseUrl();
  try {
    const s = String(localStorage.getItem(KEY_BASE_URL) || "").trim();
    return s || defaultBaseUrl();
  } catch {
    return defaultBaseUrl();
  }
}

export function setBaseUrl(v: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY_BASE_URL, String(v || "").trim().replace(/\/+$/, ""));
  } catch {
    // ignore
  }
}
