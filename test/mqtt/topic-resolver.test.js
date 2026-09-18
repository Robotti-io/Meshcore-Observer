import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTopic,
  UnresolvedTopicVariableError,
  STATUS_TOPIC_TEMPLATE,
  PACKETS_TOPIC_TEMPLATE
} from '../../src/mqtt/topic-resolver.js';

test('expands the status topic template', () => {
  const topic = resolveTopic(STATUS_TOPIC_TEMPLATE, { IATA: 'CVG', PUBLIC_KEY: 'DEADBEEF' });
  assert.equal(topic, 'meshcore/CVG/DEADBEEF/status');
});

test('expands the packets topic template', () => {
  const topic = resolveTopic(PACKETS_TOPIC_TEMPLATE, { IATA: 'CVG', PUBLIC_KEY: 'DEADBEEF' });
  assert.equal(topic, 'meshcore/CVG/DEADBEEF/packets');
});

test('rejects a template variable with no provided value', () => {
  assert.throws(
    () => resolveTopic(STATUS_TOPIC_TEMPLATE, { IATA: 'CVG' }),
    UnresolvedTopicVariableError
  );
});

test('rejects a template variable given an empty string', () => {
  assert.throws(
    () => resolveTopic(STATUS_TOPIC_TEMPLATE, { IATA: 'CVG', PUBLIC_KEY: '' }),
    UnresolvedTopicVariableError
  );
});
