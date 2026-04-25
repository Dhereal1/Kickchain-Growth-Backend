const test = require('node:test');
const assert = require('node:assert/strict');

const { truthy } = require('../services/featureFlags');

test('featureFlags.truthy parses common true values', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' On ']) {
    assert.equal(truthy(v), true, `expected truthy for ${v}`);
  }
  for (const v of ['', 'false', '0', 'no', 'off', null, undefined]) {
    assert.equal(truthy(v), false, `expected false for ${String(v)}`);
  }
});

