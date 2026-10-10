import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';
import { assertRegionAnswer } from '../../src/regions/region-validation.js';
import { REGION_BODY_MAX_BYTES, REGION_CSV_MAX_BYTES, REGION_MAX_NAMES } from '../../src/regions/region-schemas.js';
import { parseRemoteResponseFrame } from '../../src/radio/remote-response-parser.js';
import { remoteFrame, remoteFrames } from '../fixtures/remote-frames.js';

function body(csv = '', clock = 0, padding = 0) {
  const head = Buffer.alloc(4); head.writeUInt32LE(clock);
  return { body: [...head, ...Buffer.from(csv), ...Array(padding).fill(0)] };
}
const parse = (csv, clock, padding) => parseRegionResponseBody(body(csv, clock, padding));

test('pinned tagged empty region reply is a measured empty answer with separate clock and unknown completeness', () => {
  const envelope = parseRemoteResponseFrame(remoteFrame(remoteFrames.emptyRegions)).envelope;
  assert.deepEqual(parseRegionResponseBody({ body: envelope.body }), { status: 'accepted', answer: {
    regions: [], repeaterClock: 0x01020304, bodyBytes: 12, csvBytes: 0,
    parserVersion: 1, completeness: 'unknown', provenance: 'companion-tag-attributed'
  } });
  assert.deepEqual(parse('', 0).answer.regions, []);
  assert.equal(parse('', 0).answer.repeaterClock, 0);
  assert.equal(parse('', 0xFFFFFFFF).answer.repeaterClock, 0xFFFFFFFF);
});

test('CSV preserves exact case, wildcard, names, whitespace, Unicode, duplicates, order and BOM', () => {
  const regions = ['*', 'Be', 'be-vlg', '#Name', ' Be ', 'Be', 'é', '東', '😀', '\uFEFFName'];
  const csv = regions.join(','); const input = body(csv, 17, 9), before = { body: [...input.body] };
  const result = parseRegionResponseBody(input);
  assert.deepEqual(result.answer.regions, regions); assert.deepEqual(input, before);
  assert.equal(result.answer.csvBytes, Buffer.byteLength(csv));
  assert.equal(result.answer.bodyBytes, 4 + Buffer.byteLength(csv) + 9);
  assert.deepEqual(parse('\uFEFFBe', 1).answer.regions, ['\uFEFFBe']);
  assert.deepEqual(parse(' ').answer.regions, [' ']);
  result.answer.regions[0] = 'changed'; assert.deepEqual(input, before);
});

test('host maximum envelope, CSV byte budget and name-count boundary are accepted without completeness inference', () => {
  assert.equal(REGION_BODY_MAX_BYTES, 170); assert.equal(REGION_CSV_MAX_BYTES, 166); assert.equal(REGION_MAX_NAMES, 83);
  for (const csv of ['x'.repeat(166), 'é'.repeat(83), Array(83).fill('a').join(',')]) {
    const result = parse(csv); assert.equal(result.status, 'accepted');
    assert.equal(result.answer.completeness, 'unknown'); assertRegionAnswer(result.answer);
  }
  assert.equal(parse('é'.repeat(83)).answer.csvBytes, 166);
  assert.equal(parse(Array(83).fill('a').join(','), 0, 1).answer.bodyBytes, 170);
  assert.equal(parse('', 0, 166).answer.csvBytes, 0);
  assert.deepEqual(parse('x'.repeat(167)), { status: 'malformed', reason: 'invalid-body' });
  assert.equal(parse(Array(84).fill('a').join(',')).status, 'malformed');
});

test('only trailing CSV NULs are removed; clock zero bytes and non-NUL suffixes remain meaningful', () => {
  assert.equal(parse('Be', 0, 10).answer.repeaterClock, 0);
  assert.deepEqual(parse('Be ', 0, 10).answer.regions, ['Be ']);
  assert.deepEqual(parse('Be\0be', 0, 10), { status: 'malformed', reason: 'invalid-regions' });
  assert.deepEqual(parse('\0Be'), { status: 'malformed', reason: 'invalid-regions' });
  assert.deepEqual(parse('Be\0 '), { status: 'malformed', reason: 'invalid-regions' });
});

test('empty CSV fields and control characters are rejected without partial answers', () => {
  for (const csv of [',', ',Be', 'Be,', 'Be,,be', 'Be,\0', '\n', '\r', '\t', '\x1F', '\x7F', '\u0085', '\u009F',
    'Be\n', 'Be\r', 'Be\r\n']) {
    assert.deepEqual(parse(csv), { status: 'malformed', reason: 'invalid-regions' });
  }
  assert.equal(parse('Be,be').status, 'accepted');
});

test('fatal UTF-8 rejects malformed sequences and never replaces them or poisons the next decode', () => {
  for (const tail of [[0x80], [0xC0, 0xAF], [0xE2, 0x82], [0xED, 0xA0, 0x80], [0xF4, 0x90, 0x80, 0x80]]) {
    assert.deepEqual(parseRegionResponseBody({ body: [0, 0, 0, 0, ...tail] }), { status: 'malformed', reason: 'invalid-utf8' });
    assert.deepEqual(parse('Be').answer.regions, ['Be']);
  }
  assert.deepEqual(parse('�').answer.regions, ['�'], 'a valid explicitly encoded replacement character is preserved');
});

test('raw schema rejects all short bodies, coercion, sparse/typed arrays and extra identity fields before parsing', () => {
  for (let length = 0; length < 4; length++) assert.deepEqual(parseRegionResponseBody({ body: Array(length).fill(0) }),
    { status: 'malformed', reason: 'invalid-body' });
  const input = body('Be');
  for (const value of [null, undefined, [], {}, { body: 'SECRET' }, { body: new Array(4) },
    { body: Buffer.alloc(4) }, { body: new Uint8Array(4) }, { ...input, tag: 1 },
    { ...input, targetPublicKey: 'AC'.repeat(32) }, { ...input, password: 'SECRET' },
    ...[-1, 256, 1.5, '0', null, undefined, NaN, Infinity].map(n => ({ body: [0, 0, 0, n] }))]) {
    assert.deepEqual(parseRegionResponseBody(value), { status: 'malformed', reason: 'invalid-body' });
  }
  assert.deepEqual(Object.keys(parse('Be').answer).sort(),
    ['regions', 'repeaterClock', 'bodyBytes', 'csvBytes', 'parserVersion', 'completeness', 'provenance'].sort());
});

test('normalized validation protects byte/count/clock/length and UTF-16 invariants with fixed safe errors', () => {
  const answer = parse('Be').answer;
  assertRegionAnswer({ ...answer, repeaterClock: null }); // Explicit durable unavailability, never wire inference.
  const invalid = [
    { ...answer, regions: ['é'.repeat(166)] }, { ...answer, regions: ['\uD800'], csvBytes: 3 },
    { ...answer, regions: ['Be,be'] }, { ...answer, regions: [''] }, { ...answer, regions: ['\n'] },
    { ...answer, regions: ['Be\n'], csvBytes: 3, bodyBytes: 7 },
    { ...answer, regions: Array(84).fill('a') }, { ...answer, csvBytes: 3 }, { ...answer, bodyBytes: 5 },
    { ...answer, completeness: 'complete' }, { ...answer, parserVersion: 2 }, { ...answer, provenance: 'verified-sender' },
    { ...answer, repeaterClock: -1 }, { ...answer, repeaterClock: 0x100000000 }, { ...answer, repeaterClock: '17' },
    { ...answer, truncated: false }, { ...answer, raw: 'SECRET' }, { ...answer, tag: 1 }
  ];
  for (const input of invalid) assert.throws(() => assertRegionAnswer(input), error => error.message === 'Invalid region data');
  assert.equal(parseRegionResponseBody(body('Be')).status, 'accepted');
});
