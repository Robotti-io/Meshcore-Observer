import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObserverPublisher } from '../../src/mqtt/observer-publisher.js';

function fakeMqttManager() {
  const calls = [];
  return {
    calls,
    publish: async (topic, payload, options) => {
      calls.push({ topic, payload, options });
    }
  };
}

test('publishes a packet to the packets topic, keyed by the packet origin_id', async () => {
  const mqttManager = fakeMqttManager();
  const publisher = new ObserverPublisher({ mqttManager, iata: 'CVG', clientVersion: '1.0.0' });

  const packet = { origin_id: 'DEADBEEF', packet_type: '5' };
  await publisher.publishPacket(packet);

  assert.equal(mqttManager.calls.length, 1);
  assert.equal(mqttManager.calls[0].topic, 'meshcore/CVG/DEADBEEF/packets');
  assert.deepEqual(JSON.parse(mqttManager.calls[0].payload), packet);
  assert.deepEqual(mqttManager.calls[0].options, { retain: false });
});

test('publishes a retained status payload to the status topic, keyed by device public key', async () => {
  const mqttManager = fakeMqttManager();
  const publisher = new ObserverPublisher({ mqttManager, iata: 'CVG', clientVersion: '1.0.0' });

  await publisher.publishStatus({ publicKey: 'abc123', name: 'Node', radio: null }, 'online');

  assert.equal(mqttManager.calls.length, 1);
  assert.equal(mqttManager.calls[0].topic, 'meshcore/CVG/ABC123/status');
  assert.equal(JSON.parse(mqttManager.calls[0].payload).status, 'online');
  assert.deepEqual(mqttManager.calls[0].options, { retain: true });
});

test('status and packets topics for the same device use the same casing', async () => {
  const mqttManager = fakeMqttManager();
  const publisher = new ObserverPublisher({ mqttManager, iata: 'CVG', clientVersion: '1.0.0' });

  // RadioManager's normalizeSelfInfo produces a lowercase hex public key;
  // packet.origin_id is always uppercased by the packet decoder. Both must
  // resolve to the identical topic string for the same physical device.
  await publisher.publishStatus({ publicKey: 'deadbeef', name: 'Node', radio: null }, 'online');
  await publisher.publishPacket({ origin_id: 'DEADBEEF', packet_type: '5' });

  assert.equal(mqttManager.calls[0].topic.replace('/status', ''), mqttManager.calls[1].topic.replace('/packets', ''));
});
