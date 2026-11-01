import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isReplyPolicyAllowedByBot,
  resolveReplyDeliveryPolicy,
  sameRegionScope,
  validateCommandScopeCompatibility
} from '../../src/bots/reply-scope-policy.js';

const command = (overrides = {}) => ({ trigger: '!echo', ...overrides });
const matched = (regionScope) => ({ status: 'matched', regionScope });

test('legacy policy inherits fixed bot scope, allowlisted incoming scope, then device default', () => {
  assert.deepEqual(resolveReplyDeliveryPolicy({
    botRegionScope: 'Oki', command: command(), incomingScope: { status: 'unknown' }
  }).deliveryPolicy.scope, { mode: 'region', region: 'Oki' });
  assert.deepEqual(resolveReplyDeliveryPolicy({
    botRegionScope: ['Oki', 'Cvg'], command: command(), incomingScope: matched('Oki')
  }).deliveryPolicy.scope, { mode: 'region', region: 'Oki' });
  assert.deepEqual(resolveReplyDeliveryPolicy({
    botRegionScope: undefined, command: command(), incomingScope: { status: 'unscoped' }
  }).deliveryPolicy.scope, { mode: 'device-default' });
});

test('explicit command policy resolves without incoming scope and is snapshotted with no implicit fallback', () => {
  const result = resolveReplyDeliveryPolicy({
    botRegionScope: undefined,
    command: command({ scope: { mode: 'region', region: 'Oki' } }),
    incomingScope: { status: 'unknown' }
  });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.deliveryPolicy, {
    version: 1,
    transport: 'channel',
    scope: { mode: 'region', region: 'Oki' },
    fallback: { mode: 'none' },
    maxAttempts: 1
  });
});

test('array allowlists skip unknown and non-allowlisted incoming scopes', () => {
  for (const incomingScope of [{ status: 'unknown' }, matched('Elsewhere')]) {
    assert.deepEqual(resolveReplyDeliveryPolicy({
      botRegionScope: ['Oki'], command: command(), incomingScope
    }), { status: 'skip', reason: 'scope-not-allowed' });
  }
});

test('scope policy compatibility keeps fixed and allowlisted bots from widening', () => {
  assert.equal(validateCommandScopeCompatibility('Oki', command({
    scope: { mode: 'device-default' }
  }))?.includes('conflicts'), true);
  assert.equal(validateCommandScopeCompatibility('Oki', command({
    fallback: { mode: 'unscoped' }
  }))?.includes('conflicts'), true);
  assert.equal(validateCommandScopeCompatibility(['Oki'], command({
    scope: { mode: 'region', region: 'Elsewhere' }
  }))?.includes('allowlist'), true);
  assert.equal(validateCommandScopeCompatibility(['Oki'], command({
    fallback: { mode: 'region', region: 'Elsewhere' }
  }))?.includes('allowlist'), true);
  assert.equal(validateCommandScopeCompatibility(['Oki'], command({
    scope: { mode: 'region', region: 'Oki' }, fallback: { mode: 'region', region: 'Oki' }
  })), null);
});

test('region policy checks use the established case-sensitive transport-key mapping', () => {
  assert.equal(sameRegionScope('Oki', 'oki'), false);
  assert.equal(isReplyPolicyAllowedByBot(['Oki'], {
    scope: { mode: 'region', region: 'oki' }, fallback: { mode: 'none' }
  }), false);
  assert.equal(isReplyPolicyAllowedByBot('Oki', {
    scope: { mode: 'device-default' }, fallback: { mode: 'none' }
  }), false);
});
