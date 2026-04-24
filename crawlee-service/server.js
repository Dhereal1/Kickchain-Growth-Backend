if (!process.env.VERCEL) {
  require('dotenv').config({ path: '.env', quiet: true });
}

const express = require('express');
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
        if (i === 0) urls.push(buildDuckDuckGoHtmlUrl(q));
      }
    } else {
      throw new Error(`Unsupported search engine: ${engine}`);
    }
  }

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
      // eslint-disable-next-line no-console
      console.warn('crawlee_search_failed', {
        url: request?.loadedUrl ? '[URL]' : null,
        error: error?.message || 'error',
      });
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

function requireApiKey(req, res, next) {
  const required = String(process.env.CRAWLEE_SERVICE_API_KEY || '').trim();
  if (!required) return next();

  const apiKey = String(req.headers['x-api-key'] || '').trim();
  if (!apiKey || apiKey !== required) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return next();
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  return res.json({ ok: true, service: 'kickchain-crawlee-service', time: new Date().toISOString() });
});

app.post('/search', requireApiKey, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const queries = Array.isArray(body.queries) ? body.queries : [];
    const engine = String(body.engine || process.env.CRAWLEE_SEARCH_ENGINE || 'duckduckgo').trim() || 'duckduckgo';

    const timeoutMs = clampNumber(
      body.timeout_ms ?? process.env.CRAWLEE_SEARCH_TIMEOUT_MS,
      { min: 2000, max: 60000, fallback: 12000 }
    );
    const maxLinks = clampNumber(
      body.max_links ?? process.env.CRAWLEE_SEARCH_MAX_LINKS,
      { min: 1, max: 500, fallback: 200 }
    );
    const pagesPerQuery = clampNumber(
      body.pages_per_query ?? process.env.CRAWLEE_SEARCH_PAGES_PER_QUERY,
      { min: 1, max: 3, fallback: 1 }
    );

    const out = await searchTelegramLinksWithCrawlee({
      queries,
      maxLinks,
      perQueryPages: pagesPerQuery,
      timeoutMs,
      engine,
    });

    return res.json(out);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('crawlee search failed', { error: err?.message || String(err) });
    return res.status(500).json({ ok: false, error: err?.message || 'search_failed' });
  }
});

const port = Number(process.env.PORT || 8002) || 8002;
app.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Crawlee service running on port ${port}`);
});

