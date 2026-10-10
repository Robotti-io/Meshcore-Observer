import { test } from 'vitest';
import assert from 'node:assert/strict';
import { prepareRegionContactRead, prepareRegionAnonymousRequest, parseRegionContactFrame } from '../../src/regions/region-radio-adapter.js';
import { REGION_CONTACT_FRAME_BYTES } from '../../src/regions/region-query-schemas.js';

const targetPublicKey='AC'.repeat(32);
function frame(key=targetPublicKey,path=0) {
  const bytes=Array(REGION_CONTACT_FRAME_BYTES).fill(0);bytes[0]=3;
  bytes.splice(1,32,...Buffer.from(key,'hex'));bytes[33]=2;bytes[35]=path;return bytes;
}
const parse=bytes=>parseRegionContactFrame({ targetPublicKey,bytes });

test('fixed read and anonymous command preparation preserves full key and requests zero-hop reply without caller tags', () => {
  const target={ targetPublicKey },before={ ...target },keyBytes=Array(32).fill(0xAC);
  assert.deepEqual(prepareRegionContactRead(target),[0x1E,...keyBytes]);
  assert.deepEqual(prepareRegionAnonymousRequest(target),[0x39,...keyBytes,1,0]);
  assert.deepEqual(target,before);
  const changed=prepareRegionAnonymousRequest(target);changed[1]=0;
  assert.equal(prepareRegionAnonymousRequest(target)[1],0xAC);
});

test('command preparation rejects malformed keys and arbitrary opcodes/paths/tags before byte conversion', () => {
  for(const input of [null,{}, { targetPublicKey:'ac'.repeat(32) }, { targetPublicKey:'GG'.repeat(32) },
    { targetPublicKey:targetPublicKey+'\n' }, { targetPublicKey:targetPublicKey.slice(2) },
    { targetPublicKey,opcode:57 }, { targetPublicKey,replyPath:[1] },{ targetPublicKey,tag:42 }]) {
    for(const prepare of [prepareRegionContactRead,prepareRegionAnonymousRequest])assert.throws(()=>prepare(input),error=>error.message==='Invalid region query data');
  }
});

test('matching fixed-layout contact admits only exact zero path and returns no names/path/location data', () => {
  const bytes=frame();bytes.fill(0xFE,36);const before=[...bytes];
  assert.deepEqual(parse(bytes),{ status:'eligible',targetPublicKey,outPathLen:0 });assert.deepEqual(bytes,before);
  for(const type of [0,1,2,255]) { const input=frame();input[33]=type;assert.equal(parse(input).status,'eligible'); }
  for(const path of [1,2,63,64,128,192,255])assert.deepEqual(parse(frame(targetPublicKey,path)),{ status:'unavailable',reason:'unsafe-route' });
});

test('unrelated full-key contacts and non-contact events cannot authorize this target', () => {
  assert.deepEqual(parse(frame('BE'.repeat(32))),{ status:'ignored' });
  for(const code of [0,2,4,6,0x8C,0x8A])assert.deepEqual(parse([code,0]),{ status:'ignored' });
});

test('strict preflight errors distinguish missing/unsupported from full-table and other failure evidence', () => {
  for(const [code,reason] of [[1,'preflight-unsupported'],[2,'contact-missing'],[3,'preflight-failed'],[4,'preflight-failed'],[255,'preflight-failed']]) {
    assert.deepEqual(parse([1,code]),{ status:'unavailable',reason,errorCode:code });
  }
  for(const bytes of [[1],[1,2,0]])assert.deepEqual(parse(bytes),{ status:'malformed',reason:'invalid-contact-frame' });
});

test('malformed/unfamiliar contact frames never default to a safe route', () => {
  for(const bytes of [[],[3],frame().slice(0,-1),[...frame(),0],Array(177).fill(3)])assert.deepEqual(parse(bytes),{ status:'malformed',reason:'invalid-contact-frame' });
  for(const value of [-1,256,0.5,'0',null]) { const bytes=frame();bytes[35]=value;assert.equal(parse(bytes).status,'malformed'); }
  for(const input of [{ targetPublicKey,bytes:new Uint8Array(frame()) },{ targetPublicKey,bytes:frame(),secret:'SECRET' },
    { targetPublicKey:targetPublicKey.toLowerCase(),bytes:frame() },null])assert.deepEqual(parseRegionContactFrame(input),{ status:'malformed',reason:'invalid-contact-frame' });
});
