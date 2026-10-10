import { TextDecoder } from 'node:util';
import { regionBodySchema } from './region-schemas.js';
import { assertRegionInput, assertRegionAnswer } from './region-validation.js';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const malformed = reason => ({ status: 'malformed', reason });

/** Parse only a previously correlated region body. No tag/identity inference,
 * RF operation, storage or logging; the owning producer supplies context. */
export function parseRegionResponseBody(input) {
  try { assertRegionInput(regionBodySchema, input); }
  catch { return malformed('invalid-body'); }
  const bytes = Buffer.from(input.body);
  let end = bytes.length;
  while (end > 4 && bytes[end - 1] === 0) end--;
  const csvBytes = bytes.subarray(4, end);
  let csv;
  try { csv = utf8.decode(csvBytes); }
  catch { return malformed('invalid-utf8'); }
  const answer = {
    regions: csv === '' ? [] : csv.split(','), repeaterClock: bytes.readUInt32LE(0),
    bodyBytes: bytes.length, csvBytes: csvBytes.length, parserVersion: 1,
    completeness: 'unknown', provenance: 'companion-tag-attributed'
  };
  try { assertRegionAnswer(answer); }
  catch { return malformed('invalid-regions'); }
  return { status: 'accepted', answer };
}
