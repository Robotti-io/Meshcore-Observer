import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ObserverStatusScheduler } from '../../src/mqtt/observer-status-scheduler.js';

const active = [];
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function rig(intervalHours = 47) {
  vi.useFakeTimers(); const radio = new EventEmitter(), mqtt = new EventEmitter();
  const f = { radio, mqtt, connected: true, ready: true, generation: 1, value: 100 };
  radio.getConnectionSnapshot = () => ({ ready: f.ready, generation: f.generation });
  radio.refreshObserverStatus = vi.fn(async () => ({ publicKey: 'AA', stats: { uptime_secs: ++f.value } }));
  mqtt.hasAnyConnected = () => f.connected;
  f.publisher = { publishStatus: vi.fn(async () => [{ outcome: 'sent' }]) };
  f.logger = { info: vi.fn(), warn: vi.fn() };
  f.scheduler = new ObserverStatusScheduler({ radioManager: radio, mqttManager: mqtt,
    publisher: f.publisher, logger: f.logger, intervalHours });
  active.push(f); f.scheduler.start(); return f;
}
afterEach(async () => {
  for (const f of active.splice(0)) {
    await f.scheduler.stop(); assert.equal(f.radio.listenerCount('radio.connected'), 0);
    assert.equal(f.mqtt.listenerCount('broker.connected'), 0);
  }
  assert.equal(vi.getTimerCount(), 0); vi.useRealTimers();
});

test('broker connect and exact advertisement interval refresh readings before publishing retained status', async () => {
  const f = rig(); f.mqtt.emit('broker.connected'); await flush();
  assert.equal(f.publisher.publishStatus.mock.calls[0][0].stats.uptime_secs, 101);
  await vi.advanceTimersByTimeAsync(47 * 3600000 - 1); assert.equal(f.publisher.publishStatus.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(1); assert.equal(f.publisher.publishStatus.mock.calls.length, 2);
  assert.equal(f.publisher.publishStatus.mock.calls[1][0].stats.uptime_secs, 102);
});

test('startup-only advertisements disable periodic refresh but retain reconnect refreshes', async () => {
  const f = rig(0); f.mqtt.emit('broker.connected'); await flush();
  await vi.advanceTimersByTimeAsync(168 * 3600000);
  assert.equal(f.publisher.publishStatus.mock.calls.length, 1);
  f.radio.emit('radio.connected'); await flush(); assert.equal(f.publisher.publishStatus.mock.calls.length, 2);
});

test('disconnects suppress reads and reconnect uses the current generation', async () => {
  const f = rig(); f.connected = false;
  await vi.advanceTimersByTimeAsync(47 * 3600000); assert.equal(f.radio.refreshObserverStatus.mock.calls.length, 0);
  f.connected = true; f.ready = false; f.mqtt.emit('broker.connected'); await flush();
  assert.equal(f.radio.refreshObserverStatus.mock.calls.length, 0);
  f.ready = true; f.generation = 2; f.radio.emit('radio.connected'); await flush();
  assert.equal(f.publisher.publishStatus.mock.calls.length, 1);
});

test('concurrent triggers coalesce and a generation change discards old readings', async () => {
  const f = rig(); let resolve;
  f.radio.refreshObserverStatus = vi.fn(() => new Promise(done => { resolve = done; }));
  f.mqtt.emit('broker.connected'); f.mqtt.emit('broker.connected'); await flush();
  await vi.advanceTimersByTimeAsync(47 * 3600000);
  assert.equal(f.radio.refreshObserverStatus.mock.calls.length, 1);
  f.generation = 2; resolve({ publicKey: 'AA', stats: { uptime_secs: 100 } }); await flush();
  assert.equal(f.publisher.publishStatus.mock.calls.length, 0);
});

test('failed reads never publish stale data and the next scheduled refresh recovers without exposing errors', async () => {
  const f = rig(); f.radio.refreshObserverStatus.mockRejectedValueOnce(new Error('PRIVATE'));
  f.mqtt.emit('broker.connected'); await flush(); assert.equal(f.publisher.publishStatus.mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(47 * 3600000); assert.equal(f.publisher.publishStatus.mock.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /PRIVATE/);
});

test('a reconnect during old work receives one coalesced fresh refresh after old results are discarded', async () => {
  const f = rig(); let oldResult;
  f.radio.refreshObserverStatus.mockImplementationOnce(() => new Promise(resolve => { oldResult = resolve; }));
  f.mqtt.emit('broker.connected'); await flush();
  f.generation = 2; f.radio.emit('radio.connected'); f.mqtt.emit('broker.connected');
  oldResult({ publicKey: 'OLD' }); await flush();
  assert.equal(f.radio.refreshObserverStatus.mock.calls.length, 2);
  assert.equal(f.publisher.publishStatus.mock.calls.length, 1);
  assert.equal(f.publisher.publishStatus.mock.calls[0][0].publicKey, 'AA');
});

test('a broker connecting after publication began gets a coalesced refresh', async () => {
  const f = rig(); let finishPublish;
  f.publisher.publishStatus.mockImplementationOnce(() => new Promise(resolve => { finishPublish = resolve; }));
  f.mqtt.emit('broker.connected'); await flush();
  f.mqtt.emit('broker.connected'); f.mqtt.emit('broker.connected');
  finishPublish([{ outcome: 'sent' }]); await flush();
  assert.equal(f.publisher.publishStatus.mock.calls.length, 2);
  assert.equal(f.radio.refreshObserverStatus.mock.calls.length, 2);
});

test('stop aborts an in-flight read and prevents a late online status', async () => {
  const f = rig();
  f.radio.refreshObserverStatus = ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ publicKey: 'AA' })));
  f.mqtt.emit('broker.connected'); await flush(); await f.scheduler.stop();
  assert.equal(f.publisher.publishStatus.mock.calls.length, 0);
});
