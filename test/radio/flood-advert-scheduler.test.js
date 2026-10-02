import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AirtimeCoordinator } from '../../src/radio/airtime-coordinator.js';
import { FloodAdvertScheduler } from '../../src/radio/flood-advert-scheduler.js';
import { MetricsStore } from '../../src/metrics/store.js';

const logger = { info() {}, warn() {}, error() {} };

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeRig({ intervalHours = 0, quietMs = 0, now = () => Date.now(), sendFloodAdvert = async () => {}, schedulerLogger = logger } = {}) {
  const radioManager = new EventEmitter();
  radioManager.runCommand = (fn) => fn({ sendFloodAdvert });
  const store = new MetricsStore({ dbPath: ':memory:' });
  const airtimeCoordinator = new AirtimeCoordinator({ quietMs, now });
  radioManager.on('radio.packet', () => airtimeCoordinator.noteActivity());
  const scheduler = new FloodAdvertScheduler({
    radioManager, airtimeCoordinator, store, logger: schedulerLogger, intervalHours, pollIntervalMs: 5, now
  });
  return { radioManager, store, scheduler, schedulerLogger };
}

test('requests one startup flood advert after connection and waits for quiet air', async () => {
  let nowMs = 0;
  let sent = 0;
  const rig = makeRig({ intervalHours: 0, quietMs: 100, now: () => nowMs, sendFloodAdvert: async () => { sent += 1; } });
  rig.scheduler.start();
  rig.radioManager.emit('radio.connected');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent, 0);
  nowMs = 100;
  rig.radioManager.emit('radio.packet');
  nowMs = 199;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent, 0);
  nowMs = 200;
  await waitFor(() => sent === 1);
  await waitFor(() => rig.store.getFloodAdvertState().lastSentAt !== null);
  assert.equal(rig.store.getFloodAdvertState().lastSentAt, 200);
  await rig.scheduler.stop();
  rig.store.close();
});

test('resumes one persisted pending request without creating a duplicate startup job', async () => {
  let sent = 0;
  const rig = makeRig({ sendFloodAdvert: async () => { sent += 1; } });
  rig.store.requestFloodAdvert(Date.now());
  rig.scheduler.start();
  rig.radioManager.emit('radio.connected');
  await waitFor(() => sent === 1);
  await waitFor(() => rig.store.getFloodAdvertState().lastSentAt !== null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent, 1);
  await rig.scheduler.stop();
  rig.store.close();
});

test('requests the next advert from the prior accepted-send time', async () => {
  let nowMs = 1_000;
  let sent = 0;
  const rig = makeRig({ intervalHours: 47, now: () => nowMs, sendFloodAdvert: async () => { sent += 1; } });
  rig.scheduler.start();
  rig.radioManager.emit('radio.connected');
  await waitFor(() => sent === 1);
  await waitFor(() => rig.store.getFloodAdvertState().lastSentAt !== null);
  const dueAt = rig.store.getFloodAdvertState().nextDueAt;
  nowMs = dueAt - 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent, 1);
  nowMs = dueAt;
  await waitFor(() => sent === 2);
  await rig.scheduler.stop();
  rig.store.close();
});

test('resolves a failed flood advert attempt and logs the command error without marking it sent', async () => {
  const warnings = [];
  const rig = makeRig({
    schedulerLogger: {
      info() {},
      error() {},
      warn: (source, message, meta) => warnings.push({ source, message, meta })
    },
    sendFloodAdvert: async () => {
      throw new Error('radio send failed');
    }
  });

  rig.scheduler.start();
  rig.radioManager.emit('radio.connected');
  await waitFor(() => warnings.length === 1);

  const state = rig.store.getFloodAdvertState();
  assert.equal(state.status, 'idle');
  assert.equal(state.requestedAt, null);
  assert.equal(state.attemptStartedAt, null);
  assert.ok(Number.isInteger(state.lastAttemptAt));
  assert.equal(state.lastSentAt, null);
  assert.ok(Number.isInteger(state.nextDueAt));
  assert.deepEqual(warnings[0], {
    source: 'services.floodAdvert',
    message: 'flood advert command failed',
    meta: { error: 'radio send failed' }
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(warnings.length, 1, 'a failed startup-only advert must not enter an immediate retry loop');
  await rig.scheduler.stop();
  rig.store.close();
});
