import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildRegionPublication } from '../../src/mqtt/region-payload.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';
const source=(csv='',clock=0)=>({ observerPublicKey:'BE'.repeat(32),targetPublicKey:'AC'.repeat(32),
  answer:{ ...parseRegionResponseBody({ body:[clock,0,0,0,...Buffer.from(csv)] }).answer,observedAt:1791568800123 } });
test('CoreScope golden empty observation preserves source identity, milliseconds and remote zero clock',()=>{
  const built=buildRegionPublication(source());
  assert.equal(built.topic,'meshcore/client/'+'be'.repeat(32)+'/regions');
  assert.deepEqual(built.payload,{ type:'REGIONS',timestamp:'2026-10-09T18:00:00.123Z',
    target:'ac'.repeat(32),regions:[],truncated:true,repeater_clock:0 });
});
test('case/wildcard/order/duplicates survive; null remote clock is omitted and result cannot mutate source',()=>{
  const input=source('Be,be,*,Be');input.answer.repeaterClock=null;
  const built=buildRegionPublication(input);
  assert.deepEqual(built.payload.regions,['Be','be','*','Be']);assert.equal('repeater_clock' in built.payload,false);
  built.payload.regions.push('other');assert.equal(input.answer.regions.length,4);
});
test('strict source/payload validation rejects fabricated completeness, oversized or corrupted saved data',()=>{
  for(const change of [{ observerPublicKey:'be'.repeat(32) },{ targetPublicKey:'AA' },{ extra:true }]) {
    assert.throws(()=>buildRegionPublication({ ...source(),...change }));
  }
  for(const change of [{ completeness:'complete' },{ regions:['bad,name'] },{ observedAt:-1 },
    { observedAt:Number.MAX_SAFE_INTEGER },{ repeaterClock:0x100000000 },{ extra:true },{ regions:['é'],csvBytes:1 }]) {
    const input=source();Object.assign(input.answer,change);assert.throws(()=>buildRegionPublication(input));
  }
});
