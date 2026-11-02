import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MqttBroker } from '../../src/mqtt/mqtt-broker.js';
import { MqttManager } from '../../src/mqtt/mqtt-manager.js';

afterEach(() => vi.useRealTimers());
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const warnings = [];
  const logger = { info: () => {}, debug: () => {}, error: () => {},
    warn: (_source, _message, meta) => warnings.push(meta) };
  const clients = { slow: [], healthy: [] };
  const settings = ['slow', 'healthy'].map(id => ({ id, enabled: true, transport: 'tcp', tls: false,
    host: 'fixture', port: 1883, clientIdPrefix: id, keepalive: 60, qos: 1, retain: false,
    auth: { method: 'none' } }));
  const manager = new MqttManager({ config: { brokers: settings }, logger,
    createBroker: options => new MqttBroker({ ...options, createClient: () => {
      const client = new EventEmitter();
      client.calls = [];
      client.ends = [];
      // Healthy broker completes immediately; slow broker withholds ACKs.
      const healthy = options.config.id === 'healthy';
      client.publish = (topic, payload, settings, callback) => {
        client.calls.push({ topic, payload, options: settings, callback });
        if (healthy || settings.qos === 0) callback();
      };
      client.end = (force, _options, callback) => { client.ends.push(force); callback(); };
      clients[options.config.id].push(client);
      return client;
    } }) });
  return { manager, clients, warnings };
}

test('packet saturation is explicit, bounds retained work and reports healthy outcomes immediately', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture();
  const events = [];
  f.manager.on('broker.publishResult', result => events.push(result));
  f.manager.connectAll();
  await flush();
  f.clients.slow[0].emit('connect');
  f.clients.healthy[0].emit('connect');

  const pending = Array.from({ length: 64 }, (_, index) => f.manager.publish('packets', String(index)));
  const excess = await f.manager.publish('packets', 'excess');
  assert.deepEqual(excess.map(result => result.outcome), ['failed', 'sent']);
  assert.match(excess[0].error, /capacity exceeded/);
  assert.equal(f.clients.slow[0].calls.length, 64);
  assert.equal(events.filter(result => result.brokerId === 'healthy' && result.outcome === 'sent').length, 65);
  assert.equal(events.filter(result => result.brokerId === 'slow' && result.outcome === 'sent').length, 0);

  await vi.advanceTimersByTimeAsync(10000);
  const completed = await Promise.all(pending);
  assert.ok(completed.every(results => results[0].outcome === 'failed' && results[1].outcome === 'sent'));
  assert.equal(f.warnings.length, 65);
  assert.deepEqual(f.clients.slow[0].ends, [true]);
  assert.equal(f.manager.getBroker('slow').getState(), 'retrying');

  // Late ACKs cannot convert a failed outcome or reconnect the old client.
  const count = events.length;
  f.clients.slow[0].calls[0].callback();
  f.clients.slow[0].emit('connect');
  assert.equal(events.length, count);
  assert.equal(f.manager.getBroker('slow').getState(), 'retrying');
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(f.clients.slow.length, 2);
  await f.manager.closeAll();
  assert.equal(vi.getTimerCount(), 0);
});

test('stop settles pending packets, forces their client closed and cancels recovery', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture();
  f.manager.connectAll();
  await flush();
  f.clients.slow[0].emit('connect');
  f.clients.healthy[0].emit('connect');
  const pending = f.manager.publish('packets', 'one');
  await f.manager.closeAll();
  assert.deepEqual((await pending).map(result => result.outcome), ['failed', 'sent']);
  assert.deepEqual(f.clients.slow[0].ends, [true]);
  await vi.advanceTimersByTimeAsync(20000);
  assert.equal(f.clients.slow.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test('ordinary per-broker results preserve configured order under reverse completion', async () => {
  const f = fixture();
  const events = [];
  f.manager.on('broker.publishResult', result => events.push(result));
  f.manager.connectAll();
  await flush();
  f.clients.slow[0].emit('connect');
  f.clients.healthy[0].emit('connect');
  const pending = f.manager.publish('packets', 'one');
  await flush();
  assert.deepEqual(events.map(result => result.brokerId), ['healthy']);
  f.clients.slow[0].calls[0].callback();
  assert.deepEqual((await pending).map(result => result.brokerId), ['slow', 'healthy']);
  assert.deepEqual(events.map(result => result.brokerId), ['healthy', 'slow']);
  await f.manager.closeAll();
});

test('QoS zero completion remains immediate and bounded status emits no ordinary result event', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture();
  const events = [];
  f.manager.on('broker.publishResult', result => events.push(result));
  f.manager.connectAll();
  await flush();
  f.clients.slow[0].emit('connect');
  f.clients.healthy[0].emit('connect');
  assert.deepEqual((await f.manager.publish('packets', 'one', { qos: 0 })).map(result => result.outcome), ['sent', 'sent']);
  assert.equal(events.length, 2);
  const status = f.manager.publish('status', 'online', { retain: true, timeoutMs: 5000 });
  f.clients.slow[0].calls.at(-1).callback();
  assert.deepEqual((await status).map(result => result.outcome), ['sent', 'sent']);
  assert.equal(events.length, 2);
  await f.manager.closeAll();
  assert.equal(vi.getTimerCount(), 0);
});

test('packet deadline settles a concurrent bounded publication before retiring the shared client', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture();
  f.manager.connectAll();
  await flush();
  f.clients.slow[0].emit('connect');
  f.clients.healthy[0].emit('connect');
  const packet = f.manager.publish('packets', 'one');
  await vi.advanceTimersByTimeAsync(9999);
  const status = f.manager.publish('status', 'online', { retain: true, timeoutMs: 5000 });
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual((await packet).map(result => result.outcome), ['failed', 'sent']);
  assert.deepEqual((await status).map(result => result.outcome), ['failed', 'sent']);
  assert.deepEqual(f.clients.slow[0].ends, [true]);
  await f.manager.closeAll();
  assert.equal(vi.getTimerCount(), 0);
});
