const test = require('node:test');
const assert = require('node:assert/strict');

const { getIntelConfig } = require('../services/intelConfig');
const { extractSignals } = require('../services/signalEngine');

test('intel config includes promo keywords for stakes/fees/referrals', () => {
  const cfg = getIntelConfig();
  assert.ok(cfg.promoKeywords.includes('usdt'));
  assert.ok(cfg.promoKeywords.includes('rakeback'));
  assert.ok(cfg.promoKeywords.includes('referral'));
});

test('extractSignals matches normalized keywords across punctuation', () => {
  const text = 'No pay-to-win. Wallet supports USDT/USDC. VIP rakeback available.';
  const signals = extractSignals({
    text,
    views: 0,
    raw: null,
    config: {
      keywords: ['__none__'],
      intent_keywords: ['__none__'],
      activity_keywords: ['__none__'],
      promo_keywords: ['pay to win', 'usdt usdc', 'rakeback'],
    },
  });
  assert.equal(signals.promo_score, 3);
});

