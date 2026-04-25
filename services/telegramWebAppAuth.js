const crypto = require('crypto');

function parseInitData(initData) {
  const raw = String(initData || '').trim();
  if (!raw) return { pairs: new Map(), hash: '', auth_date: null, user: null };

  const params = new URLSearchParams(raw);
  const pairs = new Map();
  for (const [k, v] of params.entries()) pairs.set(k, v);

  const hash = pairs.get('hash') || '';
  const authDate = pairs.get('auth_date') ? Number(pairs.get('auth_date')) : null;

  let user = null;
  const userRaw = pairs.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      user = null;
    }
  }

  return { pairs, hash, auth_date: Number.isFinite(authDate) ? authDate : null, user };
}

function computeDataCheckString(pairs) {
  const items = [];
  for (const [k, v] of pairs.entries()) {
    if (k === 'hash') continue;
    items.push(`${k}=${v}`);
  }
  items.sort((a, b) => a.localeCompare(b));
  return items.join('\n');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(String(data || '')).digest();
}

function verifyTelegramWebAppInitData({
  initData,
  botToken,
  maxAgeSeconds = 24 * 60 * 60,
  nowSeconds = null,
}) {
  const token = String(botToken || '').trim().replace(/^['"]|['"]$/g, '');
  if (!token) {
    const e = new Error('BOT_TOKEN missing');
    e.code = 'BOT_TOKEN_MISSING';
    throw e;
  }

  const parsed = parseInitData(initData);
  if (!parsed.hash) {
    const e = new Error('Missing initData hash');
    e.code = 'INIT_DATA_MISSING_HASH';
    throw e;
  }

  const dataCheckString = computeDataCheckString(parsed.pairs);
  const secretKey = hmacSha256('WebAppData', token);
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const gotBuf = Buffer.from(String(parsed.hash), 'hex');
  if (expectedBuf.length !== gotBuf.length || !crypto.timingSafeEqual(expectedBuf, gotBuf)) {
    const e = new Error('Invalid initData signature');
    e.code = 'INIT_DATA_INVALID_SIGNATURE';
    throw e;
  }

  if (maxAgeSeconds > 0) {
    const now = Number.isFinite(nowSeconds) ? Number(nowSeconds) : Math.floor(Date.now() / 1000);
    const authDate = Number(parsed.auth_date || 0) || 0;
    if (!authDate) {
      const e = new Error('Missing auth_date');
      e.code = 'INIT_DATA_MISSING_AUTH_DATE';
      throw e;
    }
    if (authDate > now + 60) {
      const e = new Error('auth_date is in the future');
      e.code = 'INIT_DATA_BAD_AUTH_DATE';
      throw e;
    }
    if (now - authDate > maxAgeSeconds) {
      const e = new Error('initData is too old');
      e.code = 'INIT_DATA_EXPIRED';
      throw e;
    }
  }

  return {
    ok: true,
    user: parsed.user,
    auth_date: parsed.auth_date,
    start_param: parsed.pairs.get('start_param') || null,
    query_id: parsed.pairs.get('query_id') || null,
  };
}

module.exports = {
  parseInitData,
  verifyTelegramWebAppInitData,
};

