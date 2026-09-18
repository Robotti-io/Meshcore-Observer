import { createHmac, createDecipheriv, timingSafeEqual } from 'node:crypto';

/**
 * Verifies and decrypts a GRP_TXT ciphertext with a single channel key.
 * Wire format (see docs/project_plan.spec.md Section 21 and the reference
 * Python observer's payload_decode.py, itself following
 * https://github.com/michaelhart/meshcore-decoder):
 *   MAC   = HMAC-SHA256(key16 + 16 zero bytes, ciphertext)[:2]
 *   cipher = AES-128-ECB, no padding, key = key16
 *   plaintext = timestamp(4 LE) + flags(1) + text (UTF-8, NUL-terminated,
 *               usually "sender: message")
 *
 * @returns {{timestamp: number, flags: number, sender: string|null, text: string}|null}
 * null if the MAC doesn't verify or the plaintext is malformed - either
 * means this ciphertext wasn't actually encrypted with this key.
 */
export function decryptGroupText(ciphertext, cipherMac, key16) {
  if (ciphertext.length < 16 || ciphertext.length % 16 !== 0) {
    return null;
  }

  const key32 = Buffer.concat([key16, Buffer.alloc(16)]);
  const calculatedMac = createHmac('sha256', key32).update(ciphertext).digest().subarray(0, 2);
  if (!timingSafeEqual(calculatedMac, Buffer.from(cipherMac.subarray(0, 2)))) {
    return null;
  }

  let plaintext;
  try {
    const decipher = createDecipheriv('aes-128-ecb', key16, null);
    decipher.setAutoPadding(false);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }

  if (plaintext.length < 5) {
    return null;
  }

  const timestamp = plaintext.readUInt32LE(0);
  const flags = plaintext[4];

  let text = plaintext.subarray(5).toString('utf8');
  const nul = text.indexOf('\0');
  if (nul >= 0) {
    text = text.slice(0, nul);
  }

  // Split "sender: message" when the prefix looks like a plausible name.
  let sender = null;
  let content = text;
  const colon = text.indexOf(': ');
  if (colon > 0 && colon < 50) {
    const candidate = text.slice(0, colon);
    if (!/[:[\]]/.test(candidate)) {
      sender = candidate;
      content = text.slice(colon + 2);
    }
  }

  return { timestamp, flags, sender, text: content };
}
