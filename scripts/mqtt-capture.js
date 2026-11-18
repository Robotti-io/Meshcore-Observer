#!/usr/bin/env node

import mqtt from 'mqtt';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BROKER_URL = 'mqtt://mqtt1.okimesh.org:1883';
const DEFAULT_TOPIC_FILTER = 'meshcore/#';
const CAPTURE_DURATION_MS = 24 * 60 * 60 * 1000;
const INITIAL_SUBSCRIPTION_TIMEOUT_MS = 60 * 1000;

function usage() {
  console.log(`Usage: node scripts/mqtt-capture.js [--topic <filter>] [--output <file>]

Connect anonymously to ${BROKER_URL}, subscribe at QoS 0, and save messages
received during one hour as JSON Lines. The default filter is ${DEFAULT_TOPIC_FILTER}.
`);
}

function parseArgs(args) {
  const options = { topic: DEFAULT_TOPIC_FILTER, output: null };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true };

    if (argument !== '--topic' && argument !== '--output') {
      throw new Error(`Unknown option: ${argument}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Expected a value after ${argument}`);
    }
    index += 1;

    if (argument === '--topic') options.topic = value;
    else options.output = value;
  }

  validateTopicFilter(options.topic);
  return options;
}

function validateTopicFilter(topic) {
  if (!topic || Buffer.byteLength(topic, 'utf8') > 65535 || topic.includes('\0')) {
    throw new Error('The MQTT topic filter is empty or invalid');
  }

  const levels = topic.split('/');
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if (level.includes('#') && (level !== '#' || index !== levels.length - 1)) {
      throw new Error('The # wildcard must occupy the final topic level');
    }
    if (level.includes('+') && level !== '+') {
      throw new Error('The + wildcard must occupy a whole topic level');
    }
  }
}

function defaultOutputPath() {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  return resolve('artifacts', 'mqtt-captures', `meshcore-${timestamp}.jsonl`);
}

function decodeUtf8(payload) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}

function runCapture({ topic, output }) {
  const outputPath = resolve(output ?? defaultOutputPath());
  mkdirSync(dirname(outputPath), { recursive: true });
  const outputFd = openSync(outputPath, 'wx');
  const client = mqtt.connect(BROKER_URL, {
    clientId: `meshcore-sample-${process.pid}-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    connectTimeout: 10000,
    keepalive: 30,
    protocolVersion: 4,
    reconnectPeriod: 5000,
    resubscribe: true
  });

  let captureStartedAt = null;
  let captureEndsAt = null;
  let captureTimer = null;
  let setupTimer = null;
  let messageCount = 0;
  let finished = false;

  function finish({ reason, exitCode = 0 }) {
    if (finished) return;
    finished = true;
    clearTimeout(captureTimer);
    clearTimeout(setupTimer);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);

    try {
      closeSync(outputFd);
    } catch (error) {
      console.error(`Could not close capture file: ${error.message}`);
      exitCode = 1;
    }

    client.end(true);
    console.error(`${reason} Captured ${messageCount} messages in ${outputPath}`);
    process.exitCode = exitCode;
  }

  function onInterrupt() {
    finish({ reason: 'Capture interrupted by SIGINT.', exitCode: 130 });
  }

  function onTerminate() {
    finish({ reason: 'Capture interrupted by SIGTERM.', exitCode: 143 });
  }

  setupTimer = setTimeout(() => {
    finish({ reason: 'No successful subscription within 60 seconds.', exitCode: 1 });
  }, INITIAL_SUBSCRIPTION_TIMEOUT_MS);

  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  client.on('connect', () => {
    if (captureStartedAt !== null || finished) return;

    client.subscribe(topic, { qos: 0 }, (error, granted) => {
      if (finished) return;
      if (error) {
        finish({ reason: `Subscription failed: ${error.message}`, exitCode: 1 });
        return;
      }
      if (!Array.isArray(granted) || granted.length !== 1 || granted[0].qos !== 0) {
        finish({ reason: 'The broker did not grant the requested QoS 0 subscription.', exitCode: 1 });
        return;
      }

      clearTimeout(setupTimer);
      captureStartedAt = new Date();
      captureEndsAt = Date.now() + CAPTURE_DURATION_MS;
      captureTimer = setTimeout(() => {
        finish({ reason: 'One-hour capture complete.' });
      }, CAPTURE_DURATION_MS);

      console.error(`Subscribed to ${topic} at QoS 0; capture started ${captureStartedAt.toISOString()}.`);
      console.error('QoS 0 messages have no per-message acknowledgment; reconnect gaps can lose messages.');
    });
  });

  client.on('message', (receivedTopic, payload, packet) => {
    if (finished || captureStartedAt === null || Date.now() >= captureEndsAt) return;

    const record = {
      receivedAt: new Date().toISOString(),
      topic: receivedTopic,
      qos: packet.qos,
      retain: packet.retain,
      dup: packet.dup,
      payloadUtf8: decodeUtf8(payload),
      payloadBase64: payload.toString('base64')
    };

    try {
      writeSync(outputFd, `${JSON.stringify(record)}\n`);
      messageCount += 1;
    } catch (error) {
      finish({ reason: `Could not write a captured message: ${error.message}`, exitCode: 1 });
    }
  });

  client.on('offline', () => {
    if (!finished) console.error('Broker connection is offline; QoS 0 messages may be missed until reconnect.');
  });

  client.on('error', error => {
    if (!finished) console.error(`MQTT connection error: ${error.message}`);
  });
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage();
  else runCapture(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
