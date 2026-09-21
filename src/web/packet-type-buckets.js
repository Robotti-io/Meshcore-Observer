/**
 * The dashboard's fixed 8-category display scheme for MeshCore packet
 * types, keyed by the decoded packet's raw `packet_type` string (the
 * PAYLOAD_TYPE_* numeric code from @liamcottle/meshcore.js - see
 * ServiceHealth). This is the single source of truth for that mapping:
 * the server uses it to bucket samples before persisting them (see
 * metrics-server.js), and the same list is serialized into the dashboard
 * page for the browser to use for labels/colors, so the two can never
 * drift apart the way two hand-maintained copies could.
 *
 * Fixed categorical order - never reordered or generated. Codes not
 * explicitly listed here (REQ 0, RESPONSE 1, ANON_REQ 7, RAW_CUSTOM 15,
 * and any future code) fold into "other" rather than spending a 9th hue.
 *
 * `varName` points at one of the dashboard's 8 neutral `--cat-N` CSS
 * custom properties (the dataviz skill's validated 8-hue categorical
 * palette, in its documented fixed order) rather than a packet-type-
 * specific name, because the same 8 slots are reused for the per-bot
 * command charts too (see bot-command-buckets.js / dashboard-page.js) -
 * one validated palette for the whole dashboard, never a second one.
 */
export const PACKET_TYPE_BUCKETS = [
  { key: 'advert', codes: ['4'], label: 'Advert', varName: '--cat-1' },
  { key: 'txtMsg', codes: ['2'], label: 'Text message', varName: '--cat-2' },
  { key: 'grpTxt', codes: ['5'], label: 'Group text', varName: '--cat-3' },
  { key: 'ack', codes: ['3'], label: 'Ack', varName: '--cat-4' },
  { key: 'path', codes: ['8'], label: 'Path', varName: '--cat-5' },
  { key: 'trace', codes: ['9'], label: 'Trace', varName: '--cat-6' },
  { key: 'grpData', codes: ['6'], label: 'Group data', varName: '--cat-7' },
  { key: 'other', codes: ['0', '1', '7', '15'], label: 'Other', varName: '--cat-8' }
];

const CODE_TO_KEY = new Map(PACKET_TYPE_BUCKETS.flatMap((bucket) => bucket.codes.map((code) => [code, bucket.key])));

/** Maps a raw MeshCore packet_type code to its display bucket key, defaulting to "other". */
export function bucketKeyForCode(code) {
  return CODE_TO_KEY.get(code) ?? 'other';
}

/**
 * Re-keys a raw {code: count} map (as tracked by ServiceHealth) into the
 * fixed 8-category scheme, summing codes that share a bucket.
 *
 * @param {Record<string, number>} packetsByType
 * @returns {Record<string, number>}
 */
export function bucketPacketsByType(packetsByType) {
  const counts = {};
  for (const [code, count] of Object.entries(packetsByType ?? {})) {
    const key = bucketKeyForCode(code);
    counts[key] = (counts[key] ?? 0) + count;
  }
  return counts;
}
