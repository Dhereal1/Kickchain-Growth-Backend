const { isMatchHypeEventsEnabled } = require('../services/featureFlags');

function normalizeGroupId(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!/^-?\d+$/.test(v)) return v;
  if (v.startsWith('-')) return v;
  return `-${v}`;
}

function parseInternalGroupIds(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((x) => normalizeGroupId(x))
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, 25);
}

async function telegramSendMessage({ botToken, chatId, text, fetchFn = fetch, timeoutMs = 8000 }) {
  const token = String(botToken || '').trim().replace(/^['"]|['"]$/g, '');
  if (!token) throw new Error('BOT_TOKEN missing');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 8000));
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text || ''),
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    const json = await r.json().catch(() => null);
    if (!r.ok || !json || json.ok !== true) {
      const e = new Error(`telegram_send_failed`);
      e.details = json || null;
      throw e;
    }
    return { ok: true };
  } finally {
    clearTimeout(t);
  }
}

async function processHypeQueueOnce({
  pool,
  max = 20,
  botToken = process.env.BOT_TOKEN,
  internalGroupIds = process.env.INTERNAL_GROUP_IDS,
  fetchFn = fetch,
} = {}) {
  if (!isMatchHypeEventsEnabled()) return { ok: true, skipped: true, reason: 'disabled' };
  if (!pool) throw new Error('pool is required');

  const targets = parseInternalGroupIds(internalGroupIds);
  if (!targets.length) {
    return { ok: true, skipped: true, reason: 'no_INTERNAL_GROUP_IDS' };
  }

  const limit = Math.max(1, Math.min(100, Number(max) || 20));

  const r = await pool.query(
    `
      SELECT *
      FROM match_hype_events
      WHERE status = 'queued'
      ORDER BY id ASC
      LIMIT $1
    `,
    [limit]
  );
  const events = r.rows || [];
  if (!events.length) return { ok: true, processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const ev of events) {
    const id = Number(ev.id);
    const text = String(ev.hype_text || '').slice(0, 3900);

    try {
      // Mark running by bumping attempts (idempotent-ish).
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE match_hype_events SET attempts = COALESCE(attempts, 0) + 1 WHERE id = $1`,
        [id]
      );

      for (const chatId of targets) {
        // eslint-disable-next-line no-await-in-loop
        await telegramSendMessage({
          botToken,
          chatId: Number(chatId),
          text,
          fetchFn,
          timeoutMs: Number(process.env.TELEGRAM_HTTP_TIMEOUT_MS || 8000) || 8000,
        });
      }

      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE match_hype_events
         SET status = 'sent', sent_at = NOW(), last_error = NULL
         WHERE id = $1`,
        [id]
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      const attempts = Number(ev.attempts || 0) + 1;
      const lastError = String(err?.message || err).slice(0, 2000);
      const terminal = attempts >= 3;

      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE match_hype_events
         SET status = $2, last_error = $3
         WHERE id = $1`,
        [id, terminal ? 'failed' : 'queued', lastError]
      );
    }
  }

  return { ok: true, processed: events.length, sent, failed };
}

module.exports = {
  processHypeQueueOnce,
  _internals: {
    parseInternalGroupIds,
    normalizeGroupId,
    telegramSendMessage,
  },
};
