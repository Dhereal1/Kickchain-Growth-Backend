const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeCommunity,
  computeMessagesHash,
  computeLegacyMessagesHash,
  getCachedCommunityAnalysis,
  _internals,
} = require('../services/aiAnalysis');
const { extractTelegramLinksFromHtml } = require('../services/crawleeSearch');

test('computeMessagesHash is deterministic for same dataset', () => {
  const messages = [
    { text: 'Hello   World', posted_at: '2026-04-24T10:00:00.000Z' },
    { text: 'Need help buying tokens', posted_at: '2026-04-24T10:01:00.000Z' },
    { text: 'JOIN NOW', posted_at: '2026-04-24T10:02:00.000Z' },
    { text: 'random chat', posted_at: '2026-04-24T10:03:00.000Z' },
    { text: 'Last message', posted_at: '2026-04-24T10:04:00.000Z' },
    { text: 'older 1', posted_at: '2026-04-24T09:00:00.000Z' },
    { text: 'older 2', posted_at: '2026-04-24T09:10:00.000Z' },
    { text: 'older 3', posted_at: '2026-04-24T09:20:00.000Z' },
    { text: 'older 4', posted_at: '2026-04-24T09:30:00.000Z' },
    { text: 'older 5', posted_at: '2026-04-24T09:40:00.000Z' },
  ];

  const h1 = computeMessagesHash(messages);
  const h2 = computeMessagesHash(messages);
  assert.equal(h1, h2);
});

test('computeMessagesHash changes on content changes and count changes', () => {
  const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((t) => ({ text: t }));
  const h1 = computeMessagesHash(base);
  const mutated = base.slice();
  mutated[0] = { text: 'A-CHANGED' };
  const h2 = computeMessagesHash(mutated);
  assert.notEqual(h1, h2);

  const shorter = base.slice(0, 9);
  const h3 = computeMessagesHash(shorter);
  assert.notEqual(h1, h3);
});

test('legacy hash matches prior normalization approach shape', () => {
  const messages = ['  Hello  ', 'WORLD'];
  const h = computeLegacyMessagesHash(messages);
  // Stable known result for the normalization "hello\nworld"
  assert.equal(h.length, 64);
});

test('redactPII redacts common secrets and identifiers', () => {
  const input =
    'email a@b.com ip 192.168.0.1 phone +234 803 123 4567 key sk-abcdefghijklmnopqrstuvwxyz1234567890 jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb';
  const out = _internals.redactPII(input);
  assert.match(out, /\[EMAIL\]/);
  assert.match(out, /\[IP\]/);
  assert.match(out, /\[PHONE\]/);
  assert.match(out, /\[TOKEN\]/);
});

test('parseOpenAIResponseJson supports output_parsed, output_text, and output blocks', () => {
  const a = _internals.parseOpenAIResponseJson({ output_parsed: { ok: true } });
  assert.deepEqual(a, { ok: true });

  const b = _internals.parseOpenAIResponseJson({ output_text: '{"x":1}' });
  assert.deepEqual(b, { x: 1 });

  const c = _internals.parseOpenAIResponseJson({
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '{"y":2}' }],
      },
    ],
  });
  assert.deepEqual(c, { y: 2 });
});

test('getCachedCommunityAnalysis orders by updated_at and returns freshest valid row', async () => {
  const now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (String(sql).includes('SELECT COUNT(*)')) return { rows: [{ n: 2 }] };
        return {
          rows: [
            {
              id: 10,
              platform: 'telegram',
              community_name: 'c',
              analysis: { quality_score: 5 },
              messages_hash: 'h',
              updated_at: new Date(now).toISOString(),
            },
            {
              id: 9,
              platform: 'telegram',
              community_name: 'c',
              analysis: { quality_score: 1 },
              messages_hash: 'old',
              updated_at: new Date(now - 1000).toISOString(),
            },
          ],
        };
      },
    };
    const ensureGrowthSchema = async () => {};
    const row = await getCachedCommunityAnalysis({
      pool,
      ensureGrowthSchema,
      userId: null,
      workspaceId: null,
      platform: 'telegram',
      communityName: 'c',
      messagesHash: 'h',
      legacyMessagesHash: null,
      ttlHours: 24,
      logger: () => {},
    });
    assert.equal(row.id, 10);
    assert.ok(calls[0].sql.includes('ORDER BY updated_at DESC'));
  } finally {
    Date.now = originalNow;
  }
});

test('analyzeCommunity retries on 429 and succeeds', async () => {
  let n = 0;
  const fetchFn = async () => {
    n += 1;
    if (n === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        id: 'resp_1',
        output_text:
          '{"quality_score":7,"intent_detected":true,"category":"high_value","summary":"ok","recommended_action":"join"}',
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const out = await analyzeCommunity({
    communityName: 'test',
    messages: ['hello'],
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    timeoutMs: 5000,
    maxRetries: 2,
    fetchFn,
  });
  assert.equal(out.quality_score, 7);
  assert.equal(n, 2);
  assert.equal(out._meta.provider, 'openai');
});

test('analyzeCommunity throws typed error on malformed OpenAI response', async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ id: 'resp_x', output_text: 'not json' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(
    () =>
      analyzeCommunity({
        communityName: 'test',
        messages: ['hello'],
        apiKey: 'sk-test',
        timeoutMs: 5000,
        maxRetries: 0,
        fetchFn,
      }),
    (err) => err && err.name === 'AIAnalysisError' && err.code === 'OPENAI_PARSE_FAILED'
  );
});

test('extractTelegramLinksFromHtml extracts and normalizes t.me links', () => {
  const html = `
    <html>
      <body>
        <a href="https://t.me/some_group">a</a>
        <a href="http://t.me/Some_Other123">b</a>
        <a href="https://example.com">c</a>
        <div>t.me/third_group</div>
      </body>
    </html>
  `;
  const links = extractTelegramLinksFromHtml(html);
  assert.ok(links.includes('https://t.me/some_group'));
  assert.ok(links.includes('http://t.me/Some_Other123') || links.includes('https://t.me/Some_Other123'));
  assert.ok(links.includes('https://t.me/third_group'));
});
