function isValidHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function jsonStringifySafe(value) {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (err) {
    return JSON.stringify(String(value));
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

async function dispatchIntelWebhooks({ pool, ensureGrowthSchema, payload, runId = null }) {
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
      const delivery = await pool.query(
        `INSERT INTO webhook_deliveries (webhook_id, run_id, status, attempts, payload)
         VALUES ($1, $2, 'pending', 0, $3::jsonb)
         RETURNING id`,
        [h.id, runId, jsonStringifySafe(payload)]
      );
      const deliveryId = delivery.rows[0].id;

      const headers = {};
      if (h.secret) headers['x-kickchain-intel-secret'] = String(h.secret);

      let ok = false;
      let lastStatus = null;
      let lastError = null;

      let attempts = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        attempts = attempt;
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await postJsonWithTimeout(url, payload, { timeoutMs: 4000, headers });
          lastStatus = r.status;
          if (r.ok) {
            ok = true;
            break;
          }
          lastError = `HTTP ${r.status}`;
        } catch (err) {
          lastError = String(err?.message || err);
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }

      if (ok) {
        results.sent += 1;
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `UPDATE intel_webhooks SET last_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [h.id]
        );
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `UPDATE webhook_deliveries
           SET status='success', attempts=$1, last_status_code=$2, last_error=NULL, updated_at=NOW()
           WHERE id=$3`,
          [attempts, lastStatus, deliveryId]
        );
      } else {
        results.failed += 1;
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `UPDATE webhook_deliveries
           SET status='failed', attempts=$1, last_status_code=$2, last_error=$3, updated_at=NOW()
           WHERE id=$4`,
          [attempts, lastStatus, lastError, deliveryId]
        );
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
