function isValidHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

async function postJsonWithTimeout(url, payload, { timeoutMs = 4000, headers = {} } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: r.ok, status: r.status };
  } finally {
    clearTimeout(t);
  }
}

async function dispatchIntelWebhooks({ pool, ensureGrowthSchema, payload }) {
  await ensureGrowthSchema();

  const hooks = await pool.query(
    `SELECT id, url, secret FROM intel_webhooks WHERE enabled = TRUE ORDER BY id ASC`
  );

  const results = { sent: 0, failed: 0 };

  for (const h of hooks.rows || []) {
    const url = String(h.url || '').trim();
    if (!isValidHttpUrl(url)) {
      results.failed += 1;
      // eslint-disable-next-line no-continue
      continue;
    }

    try {
      const headers = {};
      if (h.secret) headers['x-kickchain-intel-secret'] = String(h.secret);

      // eslint-disable-next-line no-await-in-loop
      const r = await postJsonWithTimeout(url, payload, { timeoutMs: 4000, headers });
      if (r.ok) {
        results.sent += 1;
        // eslint-disable-next-line no-await-in-loop
        await pool.query(`UPDATE intel_webhooks SET last_sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [
          h.id,
        ]);
      } else {
        results.failed += 1;
      }
    } catch (err) {
      results.failed += 1;
      console.error('Webhook dispatch failed:', err?.message || String(err));
    }
  }

  return results;
}

module.exports = {
  dispatchIntelWebhooks,
};

