const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifyTelegramWebAppInitData, parseInitData } = require('../services/telegramWebAppAuth');

function buildInitData({ botToken, pairs }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) {
    params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }

  // Compute hash per Telegram WebApp algorithm.
  const items = [];
  for (const [k, v] of params.entries()) items.push(`${k}=${v}`);
  items.sort((a, b) => a.localeCompare(b));
  const dataCheckString = items.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  params.set('hash', hash);
  return params.toString();
}

test('parseInitData extracts user and hash', () => {
  const initData = 'user=%7B%22id%22%3A1%2C%22username%22%3A%22x%22%7D&auth_date=1&hash=abc';
  const out = parseInitData(initData);
  assert.equal(out.hash, 'abc');
  assert.deepEqual(out.user, { id: 1, username: 'x' });
  assert.equal(out.auth_date, 1);
});

test('verifyTelegramWebAppInitData accepts valid initData and rejects invalid hash', () => {
  const botToken = '123:ABC';
  const now = 1_700_000_000;
  const initData = buildInitData({
    botToken,
    pairs: {
      user: { id: 42, username: 'tester' },
      auth_date: String(now),
      query_id: 'AAE',
      start_param: 'KCREF',
    },
  });

  const ok = verifyTelegramWebAppInitData({ initData, botToken, nowSeconds: now + 1, maxAgeSeconds: 3600 });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.id, 42);
  assert.equal(ok.start_param, 'KCREF');

  const bad = initData.replace(/hash=[0-9a-f]+/, 'hash=deadbeef');
  assert.throws(
    () => verifyTelegramWebAppInitData({ initData: bad, botToken, nowSeconds: now + 1, maxAgeSeconds: 3600 }),
    (err) => err && err.code === 'INIT_DATA_INVALID_SIGNATURE'
  );
});

