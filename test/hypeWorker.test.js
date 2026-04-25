const test = require('node:test');
const assert = require('node:assert/strict');

const { processHypeQueueOnce, _internals } = require('../workers/hypeWorker');

test('parseInternalGroupIds normalizes ids', () => {
  const ids = _internals.parseInternalGroupIds('123,-1005,  -42  ,');
  assert.deepEqual(ids, ['-123', '-1005', '-42']);
});

test('processHypeQueueOnce sends and marks events sent', async () => {
  const prev = process.env.ENABLE_MATCH_HYPE_EVENTS;
  process.env.ENABLE_MATCH_HYPE_EVENTS = 'true';

  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('FROM match_hype_events') && String(sql).includes("status = 'queued'")) {
        return { rows: [{ id: 1, hype_text: 'hi', attempts: 0 }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const fetchFn = async () =>
    new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  try {
    const out = await processHypeQueueOnce({
      pool,
      max: 1,
      botToken: '123:ABC',
      internalGroupIds: '-1001',
      fetchFn,
    });
    assert.equal(out.ok, true);
    assert.equal(out.sent, 1);
    assert.ok(queries.some((q) => q.sql.includes('UPDATE match_hype_events') && q.sql.includes("status = 'sent'")));
  } finally {
    process.env.ENABLE_MATCH_HYPE_EVENTS = prev;
  }
});

