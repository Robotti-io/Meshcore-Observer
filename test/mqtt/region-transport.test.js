import { test,afterEach,vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MqttBroker } from '../../src/mqtt/mqtt-broker.js';
import { MqttManager } from '../../src/mqtt/mqtt-manager.js';
const logger={ info:()=>{},warn:()=>{},debug:()=>{},error:()=>{} };
const config={ id:'one',enabled:true,transport:'tcp',tls:false,host:'fixture',port:1883,
  clientIdPrefix:'fixture',keepalive:60,qos:0,retain:true,auth:{ method:'none' },regionPublication:{ enabled:true } };
const input={ brokerId:'one',topic:'meshcore/client/'+'be'.repeat(32)+'/regions',timeoutMs:1000,
  payload:{ type:'REGIONS',timestamp:'2026-10-10T00:00:00.123Z',target:'ac'.repeat(32),regions:[],truncated:true } };
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture() {
  const clients=[],options=[];
  const broker=new MqttBroker({ config,logger,createClient:opts=>{
    const client=new EventEmitter();client.calls=[];client.ends=[];
    client.publish=(topic,payload,settings,callback)=>client.calls.push({ topic,payload,settings,callback });
    client.end=(force,_options,callback)=>{client.ends.push(force);callback();};
    clients.push(client);options.push(opts);return client;
  } });
  const manager=new MqttManager({ config:{ brokers:[config] },logger,createBroker:()=>broker });
  return { broker,manager,clients,options };
}
afterEach(()=>vi.useRealTimers());
test('targeted publication validates before transport, fixes QoS/retain and waits for broker acknowledgement',async()=>{
  const f=fixture();f.broker.connect();await flush();f.clients[0].emit('connect');
  for(const change of [{ topic:'meshcore/client/BE/regions' },{ brokerId:1 },{ timeoutMs:0 },{ extra:true },
    { payload:{ ...input.payload,gps:{} } }]) await assert.rejects(f.manager.publishRegion({ ...input,...change }));
  assert.equal(f.clients[0].calls.length,0);
  let settled=false;const pending=f.manager.publishRegion(input).then(r=>{settled=true;return r;});
  const call=f.clients[0].calls[0];assert.deepEqual(call.settings,{ qos:1,retain:false });assert.equal(settled,false);
  call.callback();assert.deepEqual(await pending,{ outcome:'sent' });await f.broker.close();
});
test('unknown/disconnected destinations skip without broadcasting; private broker errors become fixed outcomes',async()=>{
  const f=fixture();assert.deepEqual(await f.manager.publishRegion(input),{ outcome:'skipped' });
  f.broker.connect();await flush();f.clients[0].emit('connect');
  assert.deepEqual(await f.manager.publishRegion({ ...input,brokerId:'missing' }),{ outcome:'skipped' });
  const pending=f.manager.publishRegion(input);f.clients[0].calls[0].callback(new Error('PASSWORD-private'));
  assert.deepEqual(await pending,{ outcome:'failed' });assert.equal(f.clients[0].calls.length,1);await f.broker.close();
});
test('manager enforces opt-in even for a connected broker when a caller supplies a valid region object',async()=>{
  const f=fixture();f.broker.connect();await flush();f.clients[0].emit('connect');
  const manager=new MqttManager({ config:{ brokers:[{ ...config,regionPublication:{ enabled:false } }] },logger,createBroker:()=>f.broker });
  assert.deepEqual(await manager.publishRegion(input),{ outcome:'skipped' });assert.equal(f.clients[0].calls.length,0);await f.broker.close();
});
test('timeout retires old client, preserves will on recovery and rejects late callbacks/events',async()=>{
  vi.useFakeTimers({ toFake:['setTimeout','clearTimeout'] });const f=fixture();
  const will={ topic:'status',payload:'offline' };f.broker.connect(will);await flush();const old=f.clients[0];old.emit('connect');
  const pending=f.manager.publishRegion(input);await vi.advanceTimersByTimeAsync(1000);
  assert.deepEqual(await pending,{ outcome:'failed' });assert.deepEqual(old.ends,[true]);assert.equal(f.broker.getState(),'retrying');
  old.calls[0].callback();old.emit('connect');old.emit('offline');old.emit('reconnect');old.emit('error',Error('private'));
  assert.equal(f.broker.getState(),'retrying');
  await vi.advanceTimersByTimeAsync(5000);await flush();assert.equal(f.clients.length,2);
  assert.deepEqual(f.options[1].will,{ ...will,qos:0,retain:true });f.clients[1].emit('connect');
  const retry=f.manager.publishRegion(input);old.calls[0].callback();assert.equal(f.clients[1].calls.length,1);
  f.clients[1].calls[0].callback();assert.deepEqual(await retry,{ outcome:'sent' });await f.broker.close();
  assert.equal(vi.getTimerCount(),0);
});
test('stop cancels timeout recovery and pending credential generation cannot resurrect a stopped client',async()=>{
  vi.useFakeTimers({ toFake:['setTimeout','clearTimeout'] });const f=fixture();f.broker.connect();await flush();f.clients[0].emit('connect');
  const pending=f.manager.publishRegion(input);await vi.advanceTimersByTimeAsync(1000);await pending;await f.broker.close();
  await vi.advanceTimersByTimeAsync(5000);assert.equal(f.clients.length,1);assert.equal(vi.getTimerCount(),0);
  let release;let created=0;
  const broker=new MqttBroker({ config:{ ...config,auth:{ method:'token',audience:'fixture' } },logger,
    getPassword:()=>new Promise(r=>{release=r;}),createClient:()=>{created++;return new EventEmitter();} });
  broker.connect();await flush();await broker.close();release('private');await flush();assert.equal(created,0);
});
test('single bounded admission rejects overlap and synchronous publish failure settles safely',async()=>{
  const f=fixture();await assert.rejects(f.broker.publishBounded('t','p',{ qos:1,retain:false,timeoutMs:1000 }));
  f.broker.connect();await flush();f.clients[0].emit('connect');
  const one=f.manager.publishRegion(input);assert.deepEqual(await f.manager.publishRegion(input),{ outcome:'failed' });
  await f.broker.close();assert.deepEqual(await one,{ outcome:'failed' });
  f.broker.connect();await flush();f.clients[1].emit('connect');f.clients[1].publish=()=>{throw Error('private');};
  assert.deepEqual(await f.manager.publishRegion(input),{ outcome:'failed' });await f.broker.close();
});
