import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../src/logging/logger.js';

function captureConsole() {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => lines.push(line);
  console.error = (line) => lines.push(line);
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

test('redacts sensitive metadata keys before logging', () => {
  const capture = captureConsole();
  try {
    const logger = createLogger({ level: 'debug' });
    logger.info('services.mqtt.letsmesh', 'JWT generated successfully', {
      jwt: 'eyJhbGciOiJIUzI1NiJ9.secret.payload',
      password: 'hunter2',
      nested: { privateKey: 'abc123', ok: true },
      audience: 'letsmesh'
    });
  } finally {
    capture.restore();
  }

  assert.equal(capture.lines.length, 1);
  const entry = JSON.parse(capture.lines[0]);
  assert.equal(entry.meta.jwt, '[REDACTED]');
  assert.equal(entry.meta.password, '[REDACTED]');
  assert.equal(entry.meta.nested.privateKey, '[REDACTED]');
  assert.equal(entry.meta.nested.ok, true);
  assert.equal(entry.meta.audience, 'letsmesh');
});

test('suppresses log lines below the configured level', () => {
  const capture = captureConsole();
  try {
    const logger = createLogger({ level: 'warn' });
    logger.debug('services.radio', 'noisy detail');
    logger.info('services.radio', 'still noisy');
    logger.warn('services.radio', 'worth seeing');
  } finally {
    capture.restore();
  }

  assert.equal(capture.lines.length, 1);
  const entry = JSON.parse(capture.lines[0]);
  assert.equal(entry.level, 'warn');
  assert.equal(entry.message, 'worth seeing');
});

test('serializes Date values in metadata as real timestamps, not "{}"', () => {
  const capture = captureConsole();
  try {
    const logger = createLogger({ level: 'info' });
    logger.info('app.health', 'health snapshot', {
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      nested: { lastConnectedAt: new Date('2024-06-15T12:30:00.000Z') },
      inArray: [new Date('2024-03-01T00:00:00.000Z')]
    });
  } finally {
    capture.restore();
  }

  const entry = JSON.parse(capture.lines[0]);
  assert.equal(entry.meta.startedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(entry.meta.nested.lastConnectedAt, '2024-06-15T12:30:00.000Z');
  assert.equal(entry.meta.inArray[0], '2024-03-01T00:00:00.000Z');
});

test('includes stable source and omits meta when none is given', () => {
  const capture = captureConsole();
  try {
    const logger = createLogger({ level: 'info' });
    logger.info('app.bootstrap', 'meshcore-observer starting');
  } finally {
    capture.restore();
  }

  const entry = JSON.parse(capture.lines[0]);
  assert.equal(entry.source, 'app.bootstrap');
  assert.equal('meta' in entry, false);
  assert.ok(entry.timestamp);
});
