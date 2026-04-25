/* global localStorage, fetch, document */

function $(id) {
  return document.getElementById(id);
}

function getStored(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : String(v);
  } catch {
    return fallback;
  }
}

function setStored(key, value) {
  try {
    localStorage.setItem(key, String(value ?? ''));
  } catch {
    // ignore
  }
}

function clearStored(keys) {
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
}

function normalizeBaseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function readLines(text) {
  return String(text || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}

function setConnectionStatus({ ok, text }) {
  const dot = $('statusDot');
  const label = $('statusText');
  if (!dot || !label) return;
  dot.classList.toggle('ok', !!ok);
  label.textContent = text || (ok ? 'Connected' : 'Disconnected');
}

function showActionStatus(text) {
  const el = $('actionStatus');
  if (!el) return;
  const msg = String(text || '').trim();
  if (!msg) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'block';
  el.textContent = msg;
}

function fmtNum(n, digits = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  return x.toLocaleString(undefined, { maximumFractionDigits: digits });
}

async function apiFetch(path, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const baseUrl = normalizeBaseUrl($('baseUrl')?.value || '');
  const token = String($('token')?.value || '').trim();
  if (!token) throw new Error('Missing Bearer token');

  const url = baseUrl ? `${baseUrl}${path}` : path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : null,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { ok: false, error: 'non_json_response', text };
    }
    if (!res.ok) {
      const err = new Error(json?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function renderKvs(items) {
  const wrap = document.createElement('div');
  wrap.className = 'kvs';
  for (const it of items) {
    const kv = document.createElement('div');
    kv.className = 'kv';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = it.key;
    const v = document.createElement('div');
    v.className = 'v';
    v.textContent = it.value;
    kv.appendChild(k);
    kv.appendChild(v);
    wrap.appendChild(kv);
  }
  return wrap;
}

function renderList(items) {
  const list = document.createElement('div');
  list.className = 'list';
  for (const item of items) list.appendChild(item);
  return list;
}

function communityCard(row, { label = null, subtitle = null } = {}) {
  const el = document.createElement('div');
  el.className = 'item';

  const top = document.createElement('div');
  top.className = 't';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = row?.name || row?.community_name || row?.community || row?.communityName || 'unknown';

  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.textContent = label || row?.platform || 'telegram';

  top.appendChild(name);
  top.appendChild(pill);

  const meta = document.createElement('div');
  meta.className = 'm';
  meta.textContent =
    subtitle ||
    row?.reason ||
    `score: ${fmtNum(row?.score, 2)} | intent: ${fmtNum(row?.intent_score)} | activity: ${fmtNum(row?.activity_score)}`;

  el.appendChild(top);
  el.appendChild(meta);
  return el;
}

function setActiveTab(tab) {
  const buttons = document.querySelectorAll('[data-tab]');
  buttons.forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
}

function setPanel(node, rawJson = null) {
  const panel = $('panel');
  const rawPanel = $('rawPanel');
  if (!panel || !rawPanel) return;
  panel.innerHTML = '';
  panel.appendChild(node);

  if (rawJson == null) {
    rawPanel.style.display = 'none';
    rawPanel.textContent = '';
  } else {
    rawPanel.textContent = JSON.stringify(rawJson, null, 2);
  }
}

async function doPing() {
  showActionStatus('');
  try {
    const health = await apiFetch('/intel/health', { method: 'GET' });
    setConnectionStatus({ ok: true, text: `Connected (${health?.status || 'ok'})` });
    return health;
  } catch (err) {
    setConnectionStatus({ ok: false, text: 'Disconnected' });
    throw err;
  }
}

async function loadOpportunities() {
  const data = await apiFetch('/intel/opportunities', { method: 'GET' });

  const summary = data?.summary || {};
  const meta = data?.metadata || {};
  const opp = data?.opportunities || {};

  const root = document.createElement('div');
  root.className = 'row';

  root.appendChild(
    renderKvs([
      { key: 'Total Opportunities', value: fmtNum(summary.total_opportunities || 0) },
      { key: 'Top Platform', value: String(summary.top_platform || '—') },
      { key: 'Confidence', value: fmtNum(meta.confidence_score || 0, 2) },
      { key: 'Generated', value: String(meta.generated_at || '—') },
    ])
  );

  const sections = [
    { key: 'high_intent', title: 'High Intent' },
    { key: 'trending', title: 'Trending' },
    { key: 'high_activity', title: 'High Activity' },
    { key: 'promo_heavy', title: 'Promo Heavy' },
  ];

  for (const s of sections) {
    const items = Array.isArray(opp[s.key]) ? opp[s.key] : [];
    const hd = document.createElement('div');
    hd.style.marginTop = '10px';
    hd.style.color = 'rgba(232,238,252,0.95)';
    hd.style.fontSize = '12px';
    hd.style.fontWeight = '700';
    hd.textContent = `${s.title} (${items.length})`;
    root.appendChild(hd);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'help';
      empty.textContent = 'No rows yet. Run a sync to ingest messages and aggregate metrics.';
      root.appendChild(empty);
      continue;
    }

    const cards = items.map((row) =>
      communityCard(
        {
          name: row?.name,
          platform: row?.platform,
          score: row?.score,
          intent_score: row?.intent_score,
          activity_score: row?.activity_score,
          reason: `score: ${fmtNum(row?.score, 2)} | intent: ${fmtNum(row?.intent_score)} | activity: ${fmtNum(
            row?.activity_score
          )} | trend: ${fmtNum(row?.trend_score)}`,
        },
        { label: String(row?.platform || 'telegram') }
      )
    );
    root.appendChild(renderList(cards));
  }

  const hot = Array.isArray(opp.hot_posts) ? opp.hot_posts : [];
  const hotHd = document.createElement('div');
  hotHd.style.marginTop = '10px';
  hotHd.style.color = 'rgba(232,238,252,0.95)';
  hotHd.style.fontSize = '12px';
  hotHd.style.fontWeight = '700';
  hotHd.textContent = `Hot Posts (24h) (${hot.length})`;
  root.appendChild(hotHd);

  if (hot.length) {
    const cards = hot.map((p) =>
      communityCard(
        {
          name: `${p?.community_name || 'unknown'} · ${p?.post_id || 'post'}`,
          platform: p?.platform,
          reason: `intent: ${fmtNum(p?.intent_score)} | engagement: ${fmtNum(p?.engagement_score)} | views: ${fmtNum(
            p?.views
          )} | posted: ${p?.posted_at || '—'}`,
        },
        { label: String(p?.platform || 'telegram'), subtitle: null }
      )
    );
    root.appendChild(renderList(cards));
  } else {
    const empty = document.createElement('div');
    empty.className = 'help';
    empty.textContent = 'No hot posts yet.';
    root.appendChild(empty);
  }

  return { data, node: root };
}

async function loadToday() {
  const data = await apiFetch('/intel/today', { method: 'GET' });
  const items = Array.isArray(data?.top_communities) ? data.top_communities : [];
  const recs = Array.isArray(data?.recommendations) ? data.recommendations : [];

  const root = document.createElement('div');
  root.className = 'row';

  root.appendChild(
    renderKvs([
      { key: 'Top Communities', value: fmtNum(items.length) },
      { key: 'Recommendations', value: fmtNum(recs.length) },
    ])
  );

  if (recs.length) {
    const hd = document.createElement('div');
    hd.style.marginTop = '10px';
    hd.style.color = 'rgba(232,238,252,0.95)';
    hd.style.fontSize = '12px';
    hd.style.fontWeight = '700';
    hd.textContent = 'Recommendations';
    root.appendChild(hd);

    const lines = document.createElement('div');
    lines.className = 'statusline';
    lines.textContent = recs.join('\n');
    root.appendChild(lines);
  }

  const hd2 = document.createElement('div');
  hd2.style.marginTop = '10px';
  hd2.style.color = 'rgba(232,238,252,0.95)';
  hd2.style.fontSize = '12px';
  hd2.style.fontWeight = '700';
  hd2.textContent = 'Top Communities';
  root.appendChild(hd2);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'help';
    empty.textContent = 'No aggregated metrics yet. Run a sync to ingest messages and aggregate.';
    root.appendChild(empty);
    return { data, node: root };
  }

  const cards = items.map((row) =>
    communityCard(
      row,
      {
        label: `${String(row?.platform || 'telegram')} · conf ${fmtNum(row?.confidence_score || 0, 2)}`,
        subtitle: `score: ${fmtNum(row?.score, 2)} | messages: ${fmtNum(row?.total_messages)} | intent: ${fmtNum(
          row?.intent_score
        )} | engagement: ${fmtNum(row?.engagement_score)}`,
      }
    )
  );
  root.appendChild(renderList(cards));

  return { data, node: root };
}

async function loadRuns() {
  const data = await apiFetch('/intel/runs', { method: 'GET' });
  const runs = Array.isArray(data?.last_5_runs) ? data.last_5_runs : [];
  const root = document.createElement('div');
  root.className = 'row';

  root.appendChild(
    renderKvs([
      { key: 'Success Rate', value: fmtNum((data?.success_rate || 0) * 100, 0) + '%' },
      { key: 'Avg Duration (ms)', value: fmtNum(data?.avg_duration_ms || 0) },
    ])
  );

  const hd = document.createElement('div');
  hd.style.marginTop = '10px';
  hd.style.color = 'rgba(232,238,252,0.95)';
  hd.style.fontSize = '12px';
  hd.style.fontWeight = '700';
  hd.textContent = 'Last 5 Runs';
  root.appendChild(hd);

  if (!runs.length) {
    const empty = document.createElement('div');
    empty.className = 'help';
    empty.textContent = 'No runs yet.';
    root.appendChild(empty);
    return { data, node: root };
  }

  const cards = runs.map((r) =>
    communityCard(
      {
        name: `run #${r?.id ?? '—'} · ${r?.status ?? 'unknown'}`,
        platform: r?.platform,
        reason: `inserted: ${fmtNum(r?.inserted_posts)} | deduped: ${fmtNum(r?.deduped_posts)} | fetched: ${fmtNum(
          r?.fetched_items
        )} | duration_ms: ${fmtNum(r?.duration_ms)}${r?.error_message ? ` | error: ${r.error_message}` : ''}`,
      },
      { label: String(r?.status || 'run') }
    )
  );
  root.appendChild(renderList(cards));
  return { data, node: root };
}

async function loadDiscovered() {
  const data = await apiFetch('/intel/discovered-communities?include_ai=0', { method: 'GET', timeoutMs: 30000 });
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];

  const root = document.createElement('div');
  root.className = 'row';
  root.appendChild(renderKvs([{ key: 'Ranked Communities', value: fmtNum(items.length) }]));

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'help';
    empty.textContent = 'No ranked communities yet. Run a sync or refresh discovery.';
    root.appendChild(empty);
    return { data, node: root };
  }

  const cards = items.slice(0, 50).map((row) =>
    communityCard(
      {
        name: row?.community_name || row?.community,
        platform: row?.platform,
        score: row?.score,
        intent_score: row?.intent_score,
        activity_score: row?.activity_score,
        reason: `${row?.decision || '—'} · conf ${fmtNum(row?.confidence_score || 0, 2)} · score ${fmtNum(
          row?.score,
          2
        )} · msgs ${fmtNum(row?.total_messages)} · intent ${fmtNum(row?.total_intent)} · avg_intent ${fmtNum(
          row?.avg_intent,
          2
        )}\n${row?.reason || ''}`,
      },
      { label: String(row?.category || row?.decision || 'community') }
    )
  );
  root.appendChild(renderList(cards));
  return { data, node: root };
}

async function loadHype() {
  const data = await apiFetch('/api/growth/hype/events?limit=50', { method: 'GET', timeoutMs: 30000 });
  const items = Array.isArray(data?.items) ? data.items : [];

  const root = document.createElement('div');
  root.className = 'row';
  root.appendChild(renderKvs([{ key: 'Events', value: fmtNum(items.length) }]));

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'help';
    empty.textContent = 'No hype events yet (or feature disabled).';
    root.appendChild(empty);
    return { data, node: root };
  }

  const cards = items.map((e) =>
    communityCard(
      {
        name: `match #${e.match_id} · ${e.status}`,
        platform: 'telegram',
        reason: `winner: ${e.winner_id} | stake: ${e.stake_amount} | attempts: ${e.attempts}\n${e.hype_text}\n${e.last_error ? `error: ${e.last_error}` : ''}`,
      },
      { label: String(e.status || 'event') }
    )
  );
  root.appendChild(renderList(cards));
  return { data, node: root };
}

function init() {
  const baseUrl = $('baseUrl');
  const token = $('token');
  const communities = $('communities');
  const configCommunities = $('configCommunities');

  if (baseUrl) baseUrl.value = getStored('kc_intel_base_url', '');
  if (token) token.value = getStored('kc_intel_token', '');
  if (communities) communities.value = getStored('kc_intel_last_communities', '');
  if (configCommunities) configCommunities.value = getStored('kc_intel_config_communities', '');

  baseUrl?.addEventListener('input', () => setStored('kc_intel_base_url', baseUrl.value));
  token?.addEventListener('input', () => setStored('kc_intel_token', token.value));
  communities?.addEventListener('input', () => setStored('kc_intel_last_communities', communities.value));
  configCommunities?.addEventListener('input', () => setStored('kc_intel_config_communities', configCommunities.value));

  $('btnClear')?.addEventListener('click', () => {
    clearStored([
      'kc_intel_base_url',
      'kc_intel_token',
      'kc_intel_last_communities',
      'kc_intel_config_communities',
    ]);
    if (baseUrl) baseUrl.value = '';
    if (token) token.value = '';
    if (communities) communities.value = '';
    if (configCommunities) configCommunities.value = '';
    setConnectionStatus({ ok: false, text: 'Disconnected' });
    showActionStatus('');
  });

  $('btnPing')?.addEventListener('click', async () => {
    try {
      showActionStatus('Pinging /intel/health...');
      const health = await doPing();
      showActionStatus(`Health:\n${JSON.stringify(health, null, 2)}`);
    } catch (err) {
      showActionStatus(`Ping failed: ${err?.message || String(err)}\n${JSON.stringify(err?.payload || {}, null, 2)}`);
    }
  });

  $('btnLoadConfig')?.addEventListener('click', async () => {
    try {
      showActionStatus('Loading config...');
      const cfg = await apiFetch('/intel/config', { method: 'GET' });
      const list = Array.isArray(cfg?.communities) ? cfg.communities : Array.isArray(cfg?.datasets) ? cfg.datasets : [];
      if (configCommunities) configCommunities.value = list.join('\n');
      setStored('kc_intel_config_communities', configCommunities?.value || '');
      showActionStatus(`Loaded config for user_id=${cfg?.user_id ?? '—'}`);
    } catch (err) {
      showActionStatus(`Load config failed: ${err?.message || String(err)}\n${JSON.stringify(err?.payload || {}, null, 2)}`);
    }
  });

  $('btnSaveConfig')?.addEventListener('click', async () => {
    try {
      const list = readLines(configCommunities?.value || '');
      showActionStatus('Saving config...');
      await apiFetch('/intel/config', { method: 'POST', body: { communities: list } });
      showActionStatus(`Saved ${list.length} communities to config.`);
    } catch (err) {
      showActionStatus(`Save config failed: ${err?.message || String(err)}\n${JSON.stringify(err?.payload || {}, null, 2)}`);
    }
  });

  $('btnSync')?.addEventListener('click', async () => {
    try {
      showActionStatus('Syncing communities (ingest + aggregate)...');
      const list = readLines(communities?.value || '');
      const body = list.length ? { communities: list } : {};
      const out = await apiFetch('/intel/sync-communities', { method: 'POST', body, timeoutMs: 45000 });
      showActionStatus(`Sync complete:\n${JSON.stringify(out, null, 2)}`);
    } catch (err) {
      showActionStatus(`Sync failed: ${err?.message || String(err)}\n${JSON.stringify(err?.payload || {}, null, 2)}`);
    }
  });

  $('btnRefresh')?.addEventListener('click', async () => {
    try {
      showActionStatus('Refreshing discovery (extract links + recompute rankings)...');
      const out = await apiFetch('/intel/discovered-communities/refresh', { method: 'POST', body: {}, timeoutMs: 45000 });
      showActionStatus(`Refresh complete:\n${JSON.stringify(out, null, 2)}`);
    } catch (err) {
      showActionStatus(`Refresh failed: ${err?.message || String(err)}\n${JSON.stringify(err?.payload || {}, null, 2)}`);
    }
  });

  const tabHandlers = {
    opportunities: async () => loadOpportunities(),
    today: async () => loadToday(),
    runs: async () => loadRuns(),
    discovered: async () => loadDiscovered(),
    hype: async () => loadHype(),
    raw: async () => ({ data: null, node: document.createElement('div') }),
  };

  const rawPanel = $('rawPanel');
  const panel = $('panel');
  if (panel) panel.innerHTML = '';

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tab = btn.getAttribute('data-tab');
      if (!tab) return;
      setActiveTab(tab);
      showActionStatus('');
      try {
        await doPing();
        if (tab === 'raw') {
          if (rawPanel) rawPanel.style.display = 'block';
          setPanel(renderKvs([{ key: 'Raw JSON', value: 'Select another tab to load data, then switch back here.' }]), null);
          return;
        }
        if (rawPanel) rawPanel.style.display = 'block';
        const { data, node } = await tabHandlers[tab]();
        setPanel(node, data);
      } catch (err) {
        const n = renderKvs([
          { key: 'Error', value: err?.message || String(err) },
          { key: 'Details', value: JSON.stringify(err?.payload || {}, null, 2) },
        ]);
        if (rawPanel) rawPanel.style.display = 'block';
        setPanel(n, err?.payload || null);
      }
    });
  });

  // Auto-load opportunities on first paint if a token is present.
  setTimeout(async () => {
    const t = String(token?.value || '').trim();
    if (!t) return;
    try {
      await doPing();
      const { data, node } = await loadOpportunities();
      if (rawPanel) rawPanel.style.display = 'block';
      setPanel(node, data);
    } catch {
      // ignore initial load errors
    }
  }, 50);
}

document.addEventListener('DOMContentLoaded', init);
