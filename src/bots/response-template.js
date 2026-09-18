// LoRa mesh channel messages have a real, small byte budget. Public/
// hashtag ("scoped or regional") channel messages specifically need to
// stay under ~120 bytes for the mesh to repeat them properly across hops -
// tighter than the ~130 byte general channel/group limit - so that's the
// default used here. Overridable per bot for cases where the operator
// knows their mesh tolerates more (or wants to be even more conservative).
export const DEFAULT_MAX_MESSAGE_BYTES = 120;

/**
 * Fills `{placeholder}` tokens in `template` from `values`. An unknown
 * placeholder is left as literal text rather than silently dropped, so a
 * typo in a custom response template is visible instead of hidden.
 */
export function renderTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/**
 * Truncates to the largest prefix of `str` whose UTF-8 encoding fits within
 * `maxBytes`, without ever splitting a multi-byte character (the replies
 * this renders lean heavily on multi-byte emoji, where a naive byte-slice
 * would produce corrupted/replacement-character output).
 */
export function truncateToUtf8Bytes(str, maxBytes) {
  let result = '';
  let bytes = 0;
  for (const char of str) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += charBytes;
  }
  return result;
}

/**
 * Renders a response template within a hard byte budget, degrading in
 * stages rather than sending an oversized message the mesh won't repeat
 * properly (or refuse outright):
 *   1. the full template, as authored;
 *   2. if too long and `values.path` is set, the same template re-rendered
 *      with an empty path (the hop-path list is the one field expected to
 *      grow unboundedly with mesh size, so it's the first thing dropped);
 *   3. if still too long, a hard UTF-8-safe truncation of whichever of the
 *      above was closest to fitting.
 *
 * @param {{template: string, values: object, maxBytes?: number}} options
 * @returns {{message: string, degraded: boolean}} `degraded` is true if the
 * full templated response did not fit and something had to give.
 */
export function renderResponse({ template, values, maxBytes = DEFAULT_MAX_MESSAGE_BYTES }) {
  const full = renderTemplate(template, values);
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) {
    return { message: full, degraded: false };
  }

  if (values.path) {
    const withoutPath = renderTemplate(template, { ...values, path: '' });
    if (Buffer.byteLength(withoutPath, 'utf8') <= maxBytes) {
      return { message: withoutPath, degraded: true };
    }
    return { message: truncateToUtf8Bytes(withoutPath, maxBytes), degraded: true };
  }

  return { message: truncateToUtf8Bytes(full, maxBytes), degraded: true };
}
