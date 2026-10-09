import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TopologyObserver } from '../../src/nodes/topology-observer.js';

const KEY = 'CD'.repeat(32);
const config = { freshnessWindowMs: 72 * 3600000, maxObservationsPerMinute: 2, pruneAfterDays: 0 };
const packet = (raw = '0D43AC019905E85C01020304') => ({ raw, origin_id: KEY, timestamp: new Date(1000).toISOString(),
  message: 'private message', hash: 'not stored', SNR: '0', RSSI: '-100' });
function fixture(changes = {}) {
  const writes = []; const samples = []; const warnings = []; let time = 0;
  const observer = new TopologyObserver({ store: { recordTopologyObservation: (item) => writes.push(item),
    recordTopologyCoverage: (item) => samples.push(item) }, runId: randomUUID(), getDeviceInfo: () => ({ publicKey: KEY }),
  logger: { warn: (...args) => warnings.push(args) }, config, monotonicNow: () => time, now: () => 10000, ...changes });
  return { observer, writes, samples, warnings, advance: (value) => { time = value; } };
}
test('every successful physical reception counts once, rolling budget suppresses without storage and reopens at equality', () => {
  const f = fixture();
  assert.equal(f.observer.observe(packet()).status, 'accepted');
  f.advance(10); assert.equal(f.observer.observe(packet()).status, 'accepted');
  for (let i = 0; i < 100; i++) assert.equal(f.observer.observe(packet()).status, 'suppressed');
  f.advance(59999); assert.equal(f.observer.observe(packet()).status, 'suppressed');
  f.advance(60000); assert.equal(f.observer.observe(packet()).status, 'accepted');
  assert.equal(f.writes.length, 3); assert.equal(f.writes[0].receivedAt, 1000);
  f.observer.flushCoverage(); assert.equal(f.samples[0].accepted, 3); assert.equal(f.samples[0].suppressed, 101);
  assert.equal(f.samples[0].failed, 0); assert.doesNotMatch(JSON.stringify(f.writes), /private message|not stored|SNR|RSSI/);
  f.observer.flushCoverage(); assert.equal(f.samples[1].accepted, 0);
});
test('failed writes consume admission, remain isolated and durable coverage retries without losing/double-counting pending counters', () => {
  const samples = []; let failCoverage = true; let writes = 0;
  const f = fixture({ store: { recordTopologyObservation() { writes++; throw new Error('secret password'); },
    recordTopologyCoverage(item) { if (failCoverage) throw new Error('secret password'); samples.push(item); } } });
  assert.equal(f.observer.observe(packet()).status, 'failed'); assert.equal(f.observer.observe(packet()).status, 'failed');
  assert.equal(f.observer.observe(packet()).status, 'suppressed'); assert.equal(writes, 2);
  f.observer.flushCoverage(); assert.equal(samples.length, 0);
  f.advance(60000); f.observer.observe(packet()); failCoverage = false; f.observer.flushCoverage();
  assert.equal(samples[0].failed, 3); assert.equal(samples[0].suppressed, 1); assert.equal(samples[0].accepted, 0);
  f.observer.flushCoverage(); assert.equal(samples[1].failed, 0);
  assert.doesNotMatch(JSON.stringify(f.warnings), /secret password/);
});
test('malformed, unsupported and valid no-relay frames have separate coverage without consuming the write budget', () => {
  const f = fixture();
  assert.equal(f.observer.observe(packet('0D43AC019905')).status, 'malformed');
  assert.equal(f.observer.observe(packet('2541AC01020304')).status, 'unsupported');
  assert.equal(f.observer.observe(packet('0D0001020304')).status, 'noRelay');
  assert.equal(f.observer.observe({ ...packet(), timestamp: 'bad' }).status, 'malformed');
  assert.equal(f.observer.observe(packet()).status, 'accepted'); assert.equal(f.observer.observe(packet()).status, 'accepted');
  f.observer.flushCoverage();
  assert.deepEqual(Object.fromEntries(['accepted', 'suppressed', 'failed', 'malformed', 'unsupported', 'noRelay'].map((key) => [key, f.samples[0][key]])),
    { accepted: 2, suppressed: 0, failed: 0, malformed: 2, unsupported: 1, noRelay: 1 });
});
test('named independent listener preserves other consumers, attaches once and detaches before a final flush', () => {
  const f = fixture(); const pipeline = new EventEmitter(); let packets = 0;
  pipeline.on('packet', () => packets++); f.observer.attach(pipeline); f.observer.attach(pipeline);
  pipeline.emit('packet', packet()); assert.equal(packets, 1); assert.equal(f.writes.length, 1);
  f.observer.stop(); f.observer.stop(); pipeline.emit('packet', packet());
  assert.equal(packets, 2); assert.equal(f.writes.length, 1); assert.equal(pipeline.listenerCount('packet'), 1);
  f.observer.flushCoverage(); assert.equal(f.samples[0].accepted, 1);
});
test('radio identity replacement retains separate coverage and context failures cannot interrupt other packet listeners', () => {
  let key = KEY; let broken = false;
  const f = fixture({ getDeviceInfo: () => { if (broken) throw new Error('radio secret'); return { publicKey: key }; } });
  f.observer.observe(packet()); key = 'AA'.repeat(32);
  assert.equal(f.observer.observe(packet()).status, 'malformed');
  f.observer.observe({ ...packet(), origin_id: key }); f.observer.flushCoverage();
  assert.deepEqual(f.samples.map((sample) => sample.observerPublicKey), [KEY, key]);
  broken = true; const pipeline = new EventEmitter(); let seen = false;
  f.observer.attach(pipeline); pipeline.on('packet', () => { seen = true; }); pipeline.emit('packet', packet()); assert.equal(seen, true);
  assert.equal(fixture({ getDeviceInfo: () => null }).observer.observe(packet()).status, 'malformed');
  assert.throws(() => fixture({ config: { ...config, maxObservationsPerMinute: 0 } }), /Invalid topology configuration/);
});
