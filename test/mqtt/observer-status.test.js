import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildObserverStatusPayload } from '../../src/mqtt/observer-status.js';

const DEVICE_INFO = {
  publicKey: 'deadbeef',
  name: 'Test Node',
  model: 'Heltec V3',
  firmwareVersion: '7 (19 Feb 2025)',
  // radioFreq is reported in kHz and radioBw in Hz by real hardware
  // (confirmed live: 910525/62500 -> "910.525MHz BW62.5kHz").
  radio: { frequency: 915000, bandwidth: 250000, spreadingFactor: 10, codingRate: 5 }
};

test('builds an online status payload with the expected shape', () => {
  const payload = buildObserverStatusPayload({
    deviceInfo: DEVICE_INFO,
    clientVersion: '1.0.0',
    status: 'online',
    now: () => new Date('2024-01-01T00:00:00.000Z')
  });

  assert.deepEqual(payload, {
    status: 'online',
    timestamp: '2024-01-01T00:00:00.000Z',
    origin: 'Test Node',
    origin_id: 'DEADBEEF',
    model: 'Heltec V3',
    firmware_version: '7 (19 Feb 2025)',
    radio: '915.000MHz BW250.0kHz SF10 CR5',
    client_version: '1.0.0'
  });
});

test('builds an offline status payload', () => {
  const payload = buildObserverStatusPayload({
    deviceInfo: DEVICE_INFO,
    clientVersion: '1.0.0',
    status: 'offline',
    now: () => new Date('2024-01-01T00:00:00.000Z')
  });
  assert.equal(payload.status, 'offline');
});

test('tolerates missing model/firmwareVersion/radio without throwing', () => {
  const payload = buildObserverStatusPayload({
    deviceInfo: { publicKey: 'abc', name: 'N', radio: null },
    clientVersion: '1.0.0',
    status: 'online',
    now: () => new Date('2024-01-01T00:00:00.000Z')
  });
  assert.equal(payload.model, null);
  assert.equal(payload.firmware_version, null);
  assert.equal(payload.radio, null);
});

test('online status carries fresh hardware statistics and an explicit disabled relay flag', () => {
  const payload = buildObserverStatusPayload({ deviceInfo: { ...DEVICE_INFO, firmwareVersion: 'v1.18.0', repeat: false,
    stats: { uptime_secs: 98765, battery_mv: 4123, noise_floor: -118 } }, clientVersion: '2.4.0', status: 'online' });
  assert.equal(payload.firmware_version, 'v1.18.0'); assert.equal(payload.repeat, false);
  assert.deepEqual(payload.stats, { uptime_secs: 98765, battery_mv: 4123, noise_floor: -118 });
});

test('offline status and Last Will omit readings that could be stale at delivery', () => {
  const payload = buildObserverStatusPayload({ deviceInfo: { ...DEVICE_INFO, stats: { uptime_secs: 100 } }, clientVersion: '2.4.0', status: 'offline' });
  assert.equal(payload.stats, undefined);
});

test('strict status validation rejects unknown stats, invalid units and nonboolean relay state', () => {
  for (const extra of [{ stats: { battery_mv: -1 } }, { stats: { uptime_secs: '100' } },
    { stats: { noise_floor: -32768 } }, { stats: { password: 'PRIVATE' } }, { repeat: 'on' }]) {
    assert.throws(() => buildObserverStatusPayload({ deviceInfo: { ...DEVICE_INFO, ...extra },
      clientVersion: '2.4.0', status: 'online' }), /Invalid observer status payload/);
  }
});
