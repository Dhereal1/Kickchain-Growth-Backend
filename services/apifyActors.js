function jsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonStringifySafe(value) {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return JSON.stringify(String(value));
  }
}

async function apifyFetchJson(url, { method = 'GET', body = null } = {}) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text().catch(() => '');
  if (!r.ok) {
    const e = new Error(`Apify API error: ${r.status}`);
    e.details = txt.slice(0, 2000);
    throw e;
  }
  return txt ? JSON.parse(txt) : null;
}

async function startActorRun({ actorId, token, input }) {
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(
    token
  )}`;
  const json = await apifyFetchJson(url, { method: 'POST', body: input || {} });
  const run = json?.data;
  return {
    runId: run?.id || null,
    status: run?.status || null,
    datasetId: run?.defaultDatasetId || null,
  };
}

async function waitForRun({ runId, token, timeoutMs = 25000, pollMs = 750 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const json = await apifyFetchJson(
      `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(
        token
      )}`
    );
    const run = json?.data;
    const status = run?.status;
    if (status === 'SUCCEEDED') {
      return { status, datasetId: run?.defaultDatasetId || null };
    }
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      const e = new Error(`Apify run failed: ${status}`);
      e.details = jsonStringifySafe(run || {});
      throw e;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Apify run timeout after ${timeoutMs}ms`);
}

async function fetchDatasetItems({ datasetId, token, limit = 200, offset = 0 }) {
  const params = new URLSearchParams();
  params.set('clean', 'true');
  params.set('format', 'json');
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('token', token);

  const url = `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?${params.toString()}`;
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const e = new Error(`Apify dataset error: ${r.status}`);
    e.details = t.slice(0, 2000);
    throw e;
  }
  const json = await r.json().catch(() => []);
  return Array.isArray(json) ? json : [];
}

function buildInputFromTemplate({ templateJson, vars }) {
  const tpl = String(templateJson || '').trim();
  if (!tpl) return null;
  const rendered = tpl.replace(/\{\{\s*community\s*\}\}/g, String(vars.community || ''));
  return jsonParse(rendered, null);
}

function buildTelegramScraperInputForActor({ actorId, community }) {
  const a = String(actorId || '').trim();
  const c = String(community || '').trim();
  if (!a || !c) return null;

  // Known actor presets (minimal, optional). This is intentionally small and easy to reason about.
  // tri_angle/telegram-scraper — expects `profiles` array.
  if (a === 'GEHKCq8O4orlPjLFf') {
    return {
      profiles: [c],
      collectMessages: true,
    };
  }

  // cheapget/telegram-profile — expects `telegramUrl` array.
  if (a === 'awbKkk1w2CKtNBScC') {
    return {
      telegramUrl: [c],
    };
  }

  return null;
}

function getTelegramScraperActorCandidates() {
  const primary =
    String(process.env.APIFY_TELEGRAM_SCRAPER_ACTOR_ID_PRIMARY || '').trim() ||
    String(process.env.APIFY_TELEGRAM_SCRAPER_ACTOR_ID || '').trim();
  const secondary = String(process.env.APIFY_TELEGRAM_SCRAPER_ACTOR_ID_SECONDARY || '').trim();
  const tertiary = String(process.env.APIFY_TELEGRAM_SCRAPER_ACTOR_ID_TERTIARY || '').trim();

  const raw = [
    { key: 'primary', actorId: primary },
    { key: 'secondary', actorId: secondary },
    { key: 'tertiary', actorId: tertiary },
  ].filter((x) => x.actorId);

  // De-dupe by actorId but keep first occurrence (priority order).
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (seen.has(r.actorId)) continue;
    seen.add(r.actorId);
    out.push(r);
  }
  return out;
}

function createApifyActors() {
  const token = String(process.env.APIFY_API_TOKEN || '').trim();
  if (!token) {
    return {
      enabled: false,
      runSearch: async () => {
        throw new Error('APIFY_API_TOKEN is required');
      },
      runTelegramScraper: async () => {
        throw new Error('APIFY_API_TOKEN is required');
      },
      fetchDatasetItems: async () => {
        throw new Error('APIFY_API_TOKEN is required');
      },
      getTelegramScraperActors: () => [],
    };
  }

  const discoveryActorId = String(process.env.APIFY_DISCOVERY_ACTOR_ID || '').trim();
  const telegramInputTemplate = String(process.env.APIFY_TELEGRAM_SCRAPER_INPUT_TEMPLATE_JSON || '').trim();

  const maxWaitMs = Number(process.env.APIFY_ACTOR_MAX_WAIT_MS || 25000) || 25000;
  const datasetFetchLimit = Number(process.env.APIFY_DISCOVERY_DATASET_LIMIT || 200) || 200;

  async function runSearch({ queries, input: inputOverride = null } = {}) {
    if (!discoveryActorId) {
      throw new Error('APIFY_DISCOVERY_ACTOR_ID is not set');
    }

    const qs = Array.isArray(queries) ? queries : [];
    const baseInput = jsonParse(process.env.APIFY_DISCOVERY_INPUT_JSON, null) || {};

    // Default to a common Google-search actor shape (e.g. apify/google-search-scraper).
    // Keep it minimal and overrideable via APIFY_DISCOVERY_INPUT_JSON.
    const overrideObj =
      inputOverride && typeof inputOverride === 'object' ? inputOverride : {};

    const input = {
      maxResultsPerPage: 5,
      ...baseInput,
      ...overrideObj,
    };

    // Best-effort mapping: support either `searchStringsArray` (common) or `queries` (custom actors).
    if (Array.isArray(input.searchStringsArray)) {
      // Keep env-provided input if present.
    } else if (qs.length) {
      input.searchStringsArray = qs;
    }

    // IMPORTANT: Do NOT auto-set `input.queries` to an array.
    // Some Apify actors (including popular search actors) define `queries` as a single string
    // (often newline-separated). Sending an array triggers "input.queries must be string".
    if (typeof input.queries === 'string' && qs.length) {
      // If user provided an empty string, populate it; otherwise leave as-is.
      if (!input.queries.trim()) input.queries = qs.join('\n');
    }

    async function startWithOptionalRetry(actorInput) {
      try {
        const started = await startActorRun({ actorId: discoveryActorId, token, input: actorInput });
        if (!started.runId) throw new Error('Apify search run did not return runId');
        return started;
      } catch (err) {
        const msg = String(err?.details || err?.message || '');
        const parsed = jsonParse(err?.details, null);
        const detailMsg = String(parsed?.error?.message || msg);

        // One-shot compatibility retry for actors that expect nested `input.queries` string.
        if (
          detailMsg.toLowerCase().includes('input.queries') &&
          (detailMsg.toLowerCase().includes('required') || detailMsg.toLowerCase().includes('must be string'))
        ) {
          const retryInput = { ...(actorInput || {}) };
          const nested = retryInput.input && typeof retryInput.input === 'object' && !Array.isArray(retryInput.input)
            ? { ...retryInput.input }
            : {};

          const qStr =
            (typeof nested.queries === 'string' && nested.queries.trim()) ? nested.queries
              : (typeof retryInput.queries === 'string' && retryInput.queries.trim()) ? retryInput.queries
                : qs.join('\n');

          nested.queries = qStr;
          retryInput.input = nested;

          // Ensure we don't keep an array `queries` around (some actors validate it as string).
          if (Array.isArray(retryInput.queries)) delete retryInput.queries;

          const started = await startActorRun({ actorId: discoveryActorId, token, input: retryInput });
          if (!started.runId) throw new Error('Apify search run did not return runId');
          return started;
        }

        throw err;
      }
    }

    const started = await startWithOptionalRetry(input);

    const finished = await waitForRun({ runId: started.runId, token, timeoutMs: maxWaitMs });
    const datasetId = finished.datasetId || started.datasetId;
    if (!datasetId) throw new Error('Apify search run did not return datasetId');

    const items = await fetchDatasetItems({ datasetId, token, limit: datasetFetchLimit });
    return { runId: started.runId, datasetId, items };
  }

  async function runTelegramScraper({ community, actorId }) {
    const actor =
      String(actorId || '').trim() || getTelegramScraperActorCandidates()[0]?.actorId || '';
    if (!actor) {
      throw new Error(
        'APIFY_TELEGRAM_SCRAPER_ACTOR_ID_PRIMARY/APIFY_TELEGRAM_SCRAPER_ACTOR_ID is not set'
      );
    }

    const username = String(community || '').trim();
    const inputFromTpl = buildInputFromTemplate({
      templateJson: telegramInputTemplate,
      vars: { community: username },
    });

    const presetInput = buildTelegramScraperInputForActor({ actorId: actor, community: username });

    const input =
      inputFromTpl ||
      presetInput ||
      jsonParse(process.env.APIFY_TELEGRAM_SCRAPER_INPUT_JSON, null) || {
        startUrls: [
          {
            url: `https://t.me/${username.replace(/^@/, '')}`,
          },
        ],
      };

    const started = await startActorRun({ actorId: actor, token, input });
    if (!started.runId) throw new Error('Apify telegram scrape did not return runId');
    const finished = await waitForRun({ runId: started.runId, token, timeoutMs: maxWaitMs });
    const datasetId = finished.datasetId || started.datasetId;
    return { runId: started.runId, datasetId };
  }

  return {
    enabled: true,
    runSearch,
    runTelegramScraper,
    fetchDatasetItems: async ({ datasetId, limit = 1, offset = 0 }) =>
      fetchDatasetItems({ datasetId, token, limit, offset }),
    getTelegramScraperActors: () => getTelegramScraperActorCandidates(),
  };
}

module.exports = {
  createApifyActors,
};
