import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createBackgroundAdmissions } from '../../src/radio/background-admissions.js';
import { createTelemetryGuestSessions } from '../../src/telemetry/telemetry-guest-sessions.js';

test('two continuous producers alternate across 1,000 physical admissions without an accumulated queue', () => {
  let now = 0; const admissions = createBackgroundAdmissions({ now: () => now, lifetimeMs: 20000 });
  let regions = 0, telemetry = 0;
  for (let n = 0; n < 1000; n++) {
    now += 10000; admissions.note({ source: 'telemetry' }); admissions.note({ source: 'regions' });
    const source = n % 2 ? 'regions' : 'telemetry'; assert.equal(admissions.allowed(source), true);
    admissions.sent(source); admissions.note({ source }); assert.equal(admissions.allowed(source), false);
    if (source === 'regions') regions++; else telemetry++;
  }
  assert.equal(regions, 500); assert.equal(telemetry, 500);
});

test('expired/cleared demand cannot starve the remaining source, and arbitrary sources are rejected', () => {
  let now = 0; const admissions = createBackgroundAdmissions({ now: () => now, lifetimeMs: 20000 });
  admissions.note({ source: 'regions' }); admissions.note({ source: 'telemetry' }); admissions.sent('telemetry');
  admissions.note({ source: 'telemetry' });
  now = 19999; admissions.note({ source: 'telemetry' }); assert.equal(admissions.allowed('telemetry'), false);
  now = 20000; assert.equal(admissions.allowed('telemetry'), true);
  for (const input of [null, {}, { source: 'foreground' }, { source: 'regions', queue: [1] }]) assert.throws(() => admissions.note(input), /Invalid background demand/);
  admissions.note({ source: 'regions' }); admissions.clear(); assert.equal(admissions.allowed('telemetry'), true);
  admissions.note({ source: 'regions' }); admissions.note({ source: 'telemetry' }); admissions.sent('telemetry');
  admissions.note({ source: 'telemetry' });
  admissions.withdraw('regions'); assert.equal(admissions.allowed('telemetry'), true, 'unavailable peer cannot renew starvation');
});

test('guest authority is bounded to 32 entries, original policy, reporter/generation and monotonic TTL', () => {
  let now = 100; const sessions = createTelemetryGuestSessions({ now: () => now, quarantineMs: 63000 });
  const config = Object.freeze({ sessionTtlMs: 60000 }), snapshot = { ready: true, generation: 1, observerPublicKey: 'BE'.repeat(32) };
  const key = n => n.toString(16).padStart(8, '0').toUpperCase() + 'AC'.repeat(28);
  assert.equal(sessions.observe(snapshot), true);
  for (let n = 1; n <= 33; n++) assert.equal(sessions.grant(key(n), config), true);
  assert.equal(sessions.has(key(1), config), false); assert.equal(sessions.has(key(33), config), true);
  assert.equal(sessions.has(key(33), { ...config }), false);
  now = 60099; assert.equal(sessions.has(key(33), config), true); now++; assert.equal(sessions.has(key(33), config), false);
  sessions.grant(key(33), config); now--; assert.equal(sessions.has(key(33), config), false, 'rollback revokes authority'); now++;
  sessions.observe(snapshot); sessions.grant(key(33), config);
  sessions.observe({ ...snapshot, observerPublicKey: 'CD'.repeat(32) }); assert.equal(sessions.has(key(33), config), false);
  sessions.grant(key(33), config); sessions.observe({ ...snapshot, generation: 2 }); assert.equal(sessions.has(key(33), config), false);
  sessions.grant(key(33), config); sessions.observe({ ...snapshot, ready: false }); assert.equal(sessions.has(key(33), config), false);
});

test('prefix quarantine refuses capacity overflow without evicting unexpired retired evidence', () => {
  let now = 0; const sessions = createTelemetryGuestSessions({ now: () => now, quarantineMs: 63000 });
  sessions.observe({ ready: true, generation: 1, observerPublicKey: 'BE'.repeat(32) });
  const key = n => n.toString(16).padStart(8, '0').toUpperCase() + 'AC'.repeat(28);
  for (let n = 1; n <= 32; n++) { assert.equal(sessions.loginReason(key(n)), null); sessions.retire(key(n)); }
  assert.equal(sessions.loginReason(key(33)), 'login-quarantine-full'); assert.equal(sessions.loginReason(key(1)), 'login-quarantined');
  now = 62999; assert.equal(sessions.loginReason(key(1)), 'login-quarantined'); now++; assert.equal(sessions.loginReason(key(33)), null);
  sessions.clear(); assert.equal(sessions.has(key(1), {}), false);
});
