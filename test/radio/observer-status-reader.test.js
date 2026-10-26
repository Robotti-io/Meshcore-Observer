import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeDeviceQuery, readObserverStatusPart } from '../../src/radio/observer-status-reader.js';
import { deviceInfoFrame, coreStatsFrame, radioStatsFrame } from '../fixtures/observer-status-wire.js';

afterEach(() => { vi.useRealTimers(); });
function rig() {
  vi.useFakeTimers(); const connection = new EventEmitter(), writes = [];
  connection.sendToRadioFrame = async bytes => { writes.push([...bytes]); };
  return { connection, writes };
}
test('fixed-width device metadata exposes the actual release and relay flag without protocol/date/PIN confusion', () => {
  for (const repeat of [true, false]) {
    const packed = Buffer.from(deviceInfoFrame({ repeat })).subarray(20).toString('utf8');
    const result = normalizeDeviceQuery({ firmwareVer: 14, reserved: new Uint8Array([1, 2, 3, 4, 5, 6]),
      firmware_build_date: '15-Oct-2026', manufacturerModel: packed });
    assert.deepEqual(result, { model: 'Heltec V3', firmwareVersion: 'v1.18.0', repeat });
  }
  assert.deepEqual(normalizeDeviceQuery({ firmwareVer: 7, manufacturerModel: 'Older board' }),
    { model: 'Older board', firmwareVersion: null });
  assert.throws(() => normalizeDeviceQuery({ manufacturerModel: 'board', password: 'PRIVATE' }), /Invalid device metadata/);
});

for (const [kind, command, frame, data] of [
  ['metadata', [22, 3], deviceInfoFrame(), { model: 'Heltec V3', firmwareVersion: 'v1.18.0', repeat: true }],
  ['core', [56, 0], coreStatsFrame(), { battery_mv: 4123, uptime_secs: 98765 }],
  ['radio', [56, 1], radioStatsFrame(), { noise_floor: -118 }]
]) test(`${kind}: reads documented raw local response and removes listeners/timers`, async () => {
  const { connection, writes } = rig();
  const pending = readObserverStatusPart(connection, kind);
  assert.deepEqual(writes, [command]);
  for (const invalid of [null, {}, [24, 0, 256], new Array(177).fill(0), [0x8C, 0, 0, 0, 0, 0, 1]]) connection.emit('rx', invalid);
  connection.emit('rx', kind === 'core' ? radioStatsFrame() : coreStatsFrame());
  connection.emit('rx', frame);
  assert.deepEqual((await pending).data, data);
  assert.equal(connection.listenerCount('rx'), 0); assert.equal(vi.getTimerCount(), 0);
});

for (const [kind, response] of [['core', coreStatsFrame().slice(0, -1)], ['radio', radioStatsFrame({ noise: -32768 })],
  ['metadata', deviceInfoFrame().slice(0, 19)]]) test(`${kind}: matching but invalid readings are unavailable`, async () => {
  const { connection } = rig(); const pending = readObserverStatusPart(connection, kind);
  connection.emit('rx', response); assert.equal((await pending).reason, 'invalid');
  assert.equal(vi.getTimerCount(), 0);
});

test('zero voltage remains unknown while zero firmware uptime is retained', async () => {
  const { connection } = rig(); const pending = readObserverStatusPart(connection, 'core');
  connection.emit('rx', coreStatsFrame({ battery: 0, uptime: 0 }));
  assert.deepEqual((await pending).data, { uptime_secs: 0 });
});

for (const mode of ['timeout', 'abort', 'unsupported', 'rejected', 'write-error', 'hung-write']) test(`${mode}: local reads settle within bounds and clean up`, async () => {
  const { connection } = rig(), controller = new AbortController();
  if (mode === 'write-error') connection.sendToRadioFrame = async () => { throw new Error('PRIVATE'); };
  if (mode === 'hung-write') connection.sendToRadioFrame = () => new Promise(() => {});
  const pending = readObserverStatusPart(connection, 'radio', { signals: [controller.signal], timeoutMs: 100 });
  if (mode === 'abort') controller.abort();
  if (mode === 'unsupported') connection.emit('rx', [1, 1]);
  if (mode === 'rejected') connection.emit('rx', [1, 6]);
  await vi.advanceTimersByTimeAsync(101);
  const result = await pending;
  assert.equal(result.reason, mode === 'abort' ? 'aborted' : mode === 'hung-write' ? 'timeout' : mode);
  assert.equal(connection.listenerCount('rx'), 0); assert.equal(vi.getTimerCount(), 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('already-cancelled reads never issue a command', async () => {
  const { connection, writes } = rig(), controller = new AbortController(); controller.abort();
  assert.equal((await readObserverStatusPart(connection, 'core', { signals: [controller.signal] })).dispatched, false);
  assert.equal(writes.length, 0);
});
