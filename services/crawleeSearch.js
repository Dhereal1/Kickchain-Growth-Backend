const { CheerioCrawler, RequestList, Configuration, log } = require('crawlee');

function clampNumber(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeQuery(q) {
  const s = String(q || '').trim();
  return s ? s.replace(/\s+/g, ' ') : '';
}

function buildDuckDuckGoHtmlUrl(query) {
  const q = encodeURIComponent(query);
  // HTML results page (lighter than JS app).
  return `https://duckduckgo.com/html/?q=${q}`;
}

function extractTelegramLinksFromHtml(html) {
  const text = String(html || '');
  if (!text) return [];

  const matches = text.match(/(?:https?:\/\/)?t\.me\/[a-z0-9_]{5,32}/gi) || [];
  const out = new Set();
  for (const m of matches) {
    const raw = String(m || '').trim();
    if (!raw) continue;
    const normalized = raw.startsWith('http') ? raw : `https://${raw.replace(/^\/+/, '')}`;
    out.add(normalized);
  }
  return Array.from(out);
}

async function searchTelegramLinksWithCrawlee({
  queries,
  maxLinks = 200,
  perQueryPages = 1,
  timeoutMs = 12_000,
  engine = 'duckduckgo',
}) {
  const qs = (Array.isArray(queries) ? queries : []).map(normalizeQuery).filter(Boolean).slice(0, 25);
  if (!qs.length) return { ok: true, links: [], queries: [], engine };

  const limit = clampNumber(maxLinks, { min: 1, max: 500, fallback: 200 });
  const pages = clampNumber(perQueryPages, { min: 1, max: 3, fallback: 1 });
  const timeout = clampNumber(timeoutMs, { min: 2000, max: 60000, fallback: 12000 });

  const urls = [];
  for (const q of qs) {
    if (engine === 'duckduckgo') {
      for (let i = 0; i < pages; i += 1) {
        // DDG HTML does not have a consistent pagination API; multiple pages can be approximated by repeating.
        // Keep it simple and deterministic: one page per query by default.
        if (i === 0) urls.push(buildDuckDuckGoHtmlUrl(q));
      }
    } else {
      throw new Error(`Unsupported search engine: ${engine}`);
    }
  }

  // Reduce noisy logs. Callers should instrument at route-level.
  log.setLevel(log.LEVELS.ERROR);

  const config = Configuration.getGlobalConfig();
  config.set('persistStorage', false);

  const requestList = await RequestList.open(null, urls.map((u) => ({ url: u })));

  const found = new Set();
  const startedAt = Date.now();

  const crawler = new CheerioCrawler({
    requestList,
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: Math.ceil(timeout / 1000),
    async requestHandler({ body }) {
      if (Date.now() - startedAt > timeout) return;
      for (const link of extractTelegramLinksFromHtml(body)) {
        found.add(link);
        if (found.size >= limit) break;
      }
    },
    failedRequestHandler({ request, error }) {
      // Avoid throwing; just continue. Do not log full URLs with query in prod logs.
      // eslint-disable-next-line no-console
      console.warn('crawlee_search_failed', { url: request?.loadedUrl ? '[URL]' : null, error: error?.message || 'error' });
    },
  });

  await crawler.run();

  return {
    ok: true,
    engine,
    queries: qs,
    links: Array.from(found).slice(0, limit),
  };
}

module.exports = {
  searchTelegramLinksWithCrawlee,
  extractTelegramLinksFromHtml,
};

