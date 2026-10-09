import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { RuntimeEvents } from '../../src/metrics/runtime-events.js';

function fixture(maxPerMinute = 60) {
  const rows = []; const warnings = []; const radio = new EventEmitter(); radio.isConnected = () => false;
  let at = 0; let wall = 1000; let failed = false;
  const events = new RuntimeEvents({ store: { recordRuntimeEvent: (row) => { if (failed) throw new Error('disk full'); rows.push(row); } },
    runId: randomUUID(), maxPerMinute, logger: { warn: (...args) => warnings.push(args) },
    monotonicNow: () => at, wallNow: () => wall });
  events.attachRadio(radio);
  return { events, radio, rows, warnings, set: (next, nextWall = 1000 + next) => { at = next; wall = nextWall; },
    fail: (value) => { failed = value; } };
}
function snapshot(connected = false, ready = false) {
  return { mqtt: { local: { connected, password: 'never saved' } }, bots: [{ name: 'Offline', enabled: true, ready }] };
}
test('radio observations ignore free-form payloads and duplicate stable states; stop removes only owned listeners', () => {
  const { events, radio, rows } = fixture(); const other = () => {}; radio.on('radio.connected', other);
  radio.emit('radio.connected', { password: 'secret' }); radio.emit('radio.connected');
  radio.emit('radio.error', { message: 'token=secret', privateKey: 'secret' });
  radio.emit('radio.disconnected'); radio.emit('radio.disconnected');
  assert.deepEqual(rows.map((row) => row.kind), ['radio.connected', 'radio.connect-error', 'radio.disconnected']);
  assert.equal(rows[0].precision, 'event'); assert.equal(rows[0].observationWindowMs, null);
  assert.doesNotMatch(JSON.stringify(rows), /secret|password|privateKey/);
  events.stop(); events.stop(); events.attachRadio(radio); radio.emit('radio.error');
  assert.equal(rows.length, 3); assert.equal(radio.listenerCount('radio.connected'), 1);
  assert.equal(radio.listenerCount('radio.error'), 0);
});
test('sampled transitions have actual monotonic observation windows and suppress identical/initial states', () => {
  const { events, rows, set } = fixture(); events.observeSnapshot(snapshot()); events.observeSnapshot(snapshot());
  set(12500, 1); events.observeSnapshot(snapshot(true, true)); events.observeSnapshot(snapshot(true, true));
  assert.deepEqual(rows.map((row) => row.kind), ['broker.state', 'bot.readiness']);
  assert.ok(rows.every((row) => row.precision === 'sample' && row.observationWindowMs === 12500 && row.observedAt === 1));
  set(15000); events.observeSnapshot(snapshot());
  assert.deepEqual(rows.slice(2).map((row) => row.state), ['disconnected', 'not-ready']);
});
test('rolling minute budget includes failures, tolerates wall jumps, and exposes counts until persistence acknowledges them', () => {
  const { events, radio, rows, set, fail } = fixture(2);
  fail(true); radio.emit('radio.error'); fail(false); set(100); radio.emit('radio.error');
  set(59999, 99999999); radio.emit('radio.error');
  assert.equal(rows.length, 1); assert.deepEqual(events.pendingCounts(), { suppressedEvents: 1, failedEvents: 1 });
  const saved = events.pendingCounts(); radio.emit('radio.error'); events.acknowledgeCounts(saved);
  assert.deepEqual(events.pendingCounts(), { suppressedEvents: 1, failedEvents: 0 });
  set(60000, 0); radio.emit('radio.error'); assert.equal(rows.length, 2);
  set(60001); radio.emit('radio.error'); assert.equal(rows.length, 2);
  set(60100); radio.emit('radio.error'); assert.equal(rows.length, 3);
});
test('strict snapshot and budget inputs fail before state mutation', () => {
  const { events, rows } = fixture(); events.observeSnapshot(snapshot());
  assert.throws(() => events.observeSnapshot(snapshot('yes', false)), /Invalid readiness snapshot/);
  events.observeSnapshot(snapshot(true, false)); assert.equal(rows.length, 1);
  for (const maxPerMinute of [0, 601, 1.1, '60', NaN]) {
    assert.throws(() => new RuntimeEvents({ maxPerMinute }), /Invalid runtime event budget/);
  }
});
test('new or disabled services do not manufacture transitions and write failures remain nonfatal', () => {
  const { events, radio, rows, warnings, fail } = fixture(); events.observeSnapshot({ mqtt: {}, bots: [] });
  events.observeSnapshot(snapshot(true, true)); assert.equal(rows.length, 0);
  events.observeSnapshot({ mqtt: { local: { connected: true } }, bots: [{ name: 'Offline', enabled: false, ready: false }] });
  assert.equal(rows.length, 0);
  fail(true); assert.doesNotThrow(() => radio.emit('radio.connected'));
  assert.equal(warnings.length, 1); assert.equal(warnings[0][0], 'services.runtimeEvents');
});
