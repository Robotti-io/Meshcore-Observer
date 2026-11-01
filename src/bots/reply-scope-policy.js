import { deriveRegionTransportKey } from './region-scope.js';

const NO_FALLBACK = Object.freeze({ mode: 'none' });

export class ReplyPolicyError extends Error {
  constructor(reason, message, options) {
    super(message, options);
    this.name = 'ReplyPolicyError';
    this.replyReason = reason;
  }
}

export function sameRegionScope(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return deriveRegionTransportKey(left).equals(deriveRegionTransportKey(right));
}

/** Returns a config error message when command policy conflicts with bot constraints. */
export function validateCommandScopeCompatibility(botRegionScope, command) {
  const fixed = typeof botRegionScope === 'string' ? botRegionScope : null;
  const allowed = Array.isArray(botRegionScope) ? botRegionScope : null;
  const scope = command.scope;
  const explicitScope = scope && scope.mode !== 'inherit' ? scope : null;
  const fallback = command.fallback ?? NO_FALLBACK;

  if (fixed && explicitScope && (explicitScope.mode !== 'region' || !sameRegionScope(explicitScope.region, fixed))) {
    return `scope for command "${command.trigger}" conflicts with bot fixed regionScope "${fixed}"`;
  }
  if (fixed && fallback.mode !== 'none'
    && (fallback.mode !== 'region' || !sameRegionScope(fallback.region, fixed))) {
    return `fallback for command "${command.trigger}" conflicts with bot fixed regionScope "${fixed}"`;
  }
  if (allowed && explicitScope) {
    if (explicitScope.mode !== 'region' || !allowed.some((name) => sameRegionScope(name, explicitScope.region))) {
      return `scope for command "${command.trigger}" must be a region in bot regionScope allowlist`;
    }
  }
  if (allowed && fallback.mode !== 'none') {
    if (fallback.mode !== 'region' || !allowed.some((name) => sameRegionScope(name, fallback.region))) {
      return `fallback for command "${command.trigger}" must be a region in bot regionScope allowlist`;
    }
  }
  return null;
}

/** Resolves legacy inheritance and opt-in scope policy into a durable snapshot. */
export function resolveReplyDeliveryPolicy({ botRegionScope, command, incomingScope }) {
  const commandScope = command.scope;
  const explicitScope = commandScope && commandScope.mode !== 'inherit' ? commandScope : null;
  let scope;

  if (explicitScope) {
    scope = explicitScope;
  } else if (typeof botRegionScope === 'string') {
    scope = { mode: 'region', region: botRegionScope };
  } else if (Array.isArray(botRegionScope)) {
    if (incomingScope.status !== 'matched'
      || !botRegionScope.some((name) => sameRegionScope(name, incomingScope.regionScope))) {
      return { status: 'skip', reason: 'scope-not-allowed' };
    }
    scope = { mode: 'region', region: incomingScope.regionScope };
  } else if (incomingScope.status === 'matched') {
    scope = { mode: 'region', region: incomingScope.regionScope };
  } else if (incomingScope.status === 'unscoped') {
    scope = { mode: 'device-default' };
  } else {
    return { status: 'skip', reason: incomingScope.status };
  }

  const fallback = command.fallback ?? NO_FALLBACK;
  const regionScope = scope.mode === 'region' ? scope.region : null;
  return {
    status: 'resolved',
    regionScope,
    deliveryPolicy: {
      version: 1,
      transport: 'channel',
      scope: { ...scope },
      fallback: { ...fallback },
      maxAttempts: 1
    }
  };
}

/** Fails closed if a persisted snapshot no longer fits current bot constraints. */
export function isReplyPolicyAllowedByBot(botRegionScope, deliveryPolicy) {
  const fixed = typeof botRegionScope === 'string' ? botRegionScope : null;
  const allowed = Array.isArray(botRegionScope) ? botRegionScope : null;
  const policyScopes = [deliveryPolicy.scope, deliveryPolicy.fallback];

  for (const policy of policyScopes) {
    if (policy.mode === 'none') continue;
    if (fixed && (policy.mode !== 'region' || !sameRegionScope(policy.region, fixed))) return false;
    if (allowed && (policy.mode !== 'region' || !allowed.some((name) => sameRegionScope(name, policy.region)))) return false;
  }
  return true;
}
