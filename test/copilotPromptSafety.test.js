const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemPrompt, buildUserPrompt } = require('../services/copilot/prompts');

test('copilot prompts are advisory-only', () => {
  const sys = buildSystemPrompt();
  assert.match(sys, /Do NOT send messages/i);

  const user = buildUserPrompt({ kind: 'draft-dm', entityKey: 'telegram:@x', context: 'hello', tone: 'friendly' });
  assert.match(user, /Write a concise message draft/i);
});

