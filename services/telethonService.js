function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function telethonFetchJson(url, { method = 'GET', body = null, timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const txt = await r.text().catch(() => '');
    if (!r.ok) {
      const e = new Error(`Telethon service error: ${r.status}`);
      e.details = txt.slice(0, 2000);
      throw e;
    }
    return txt ? JSON.parse(txt) : null;
  } finally {
    clearTimeout(t);
  }
}

function getTelethonConfigFromEnv() {
  const baseUrl = String(process.env.TELETHON_SERVICE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(process.env.TELETHON_SERVICE_API_KEY || '').trim();
  const timeoutMs = Number(process.env.TELETHON_SERVICE_TIMEOUT_MS || 25000) || 25000;
  return { baseUrl, apiKey, timeoutMs };
}

async function runTelethonDiscovery({ queries, maxGroupsTotal = 10, maxMessagesPerGroup = 20 }) {
  const cfg = getTelethonConfigFromEnv();
  if (!cfg.baseUrl) throw new Error('TELETHON_SERVICE_URL is not set');
  const headers = {};
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

  const payload = {
    queries: Array.isArray(queries) ? queries : [],
    max_groups_total: maxGroupsTotal,
    max_messages_per_group: maxMessagesPerGroup,
  };

  // Simple retry for transient 5xx
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await telethonFetchJson(`${cfg.baseUrl}/run`, {
        method: 'POST',
        body: payload,
        timeoutMs: cfg.timeoutMs,
        headers,
      });
    } catch (err) {
      const msg = String(err?.message || '');
      if (attempt < 2 && msg.includes('Telethon service error: 5')) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
        // eslint-disable-next-line no-continue
        continue;
      }
      throw err;
    }
  }
  return null;
}

module.exports = {
  runTelethonDiscovery,
  getTelethonConfigFromEnv,
};

