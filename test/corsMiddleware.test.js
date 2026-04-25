const test = require('node:test');
const assert = require('node:assert/strict');

const { createCorsMiddleware } = require('../middleware/cors');

function makeRes() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
    statusCode: null,
  };
}

test('cors: default "*" does not enable credentials', () => {
  const mw = createCorsMiddleware({ corsOrigin: '*' });
  const req = { method: 'GET', headers: { origin: 'https://example.com' } };
  const res = makeRes();
  let nextCalled = false;

  mw(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.getHeader('access-control-allow-origin'), '*');
  assert.equal(res.getHeader('access-control-allow-credentials'), undefined);
  assert.equal(nextCalled, true);
});

test('cors: reflect allowed origin and enable credentials', () => {
  const mw = createCorsMiddleware({ corsOrigin: 'https://a.com, https://b.com' });
  const req = { method: 'GET', headers: { origin: 'https://b.com' } };
  const res = makeRes();
  mw(req, res, () => {});

  assert.equal(res.getHeader('access-control-allow-origin'), 'https://b.com');
  assert.equal(res.getHeader('access-control-allow-credentials'), 'true');
  assert.equal(res.getHeader('vary'), 'Origin');
});

test('cors: block disallowed origin with "null"', () => {
  const mw = createCorsMiddleware({ corsOrigin: 'https://a.com' });
  const req = { method: 'GET', headers: { origin: 'https://evil.com' } };
  const res = makeRes();
  mw(req, res, () => {});

  assert.equal(res.getHeader('access-control-allow-origin'), 'null');
  assert.equal(res.getHeader('access-control-allow-credentials'), undefined);
  assert.equal(res.getHeader('vary'), 'Origin');
});

test('cors: OPTIONS returns 204', () => {
  const mw = createCorsMiddleware({ corsOrigin: '*' });
  const req = { method: 'OPTIONS', headers: { origin: 'https://example.com' } };
  const res = makeRes();
  let nextCalled = false;

  mw(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 204);
  assert.equal(nextCalled, false);
});

