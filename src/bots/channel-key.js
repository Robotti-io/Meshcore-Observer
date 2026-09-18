import { createHash } from 'node:crypto';

/**
 * Derives a public/hashtag channel's 16-byte AES key from its name: the
 * first 16 bytes of SHA-256 of the lowercased "#name". This is the
 * MeshCore-wide convention (not app-specific) - anyone typing the same
 * "#name" derives the identical key, which is what makes it a *public*
 * channel. Matches the reference Python observer's derive_hashtag_key().
 */
export function deriveHashtagChannelKey(name) {
  const tag = name.startsWith('#') ? name : `#${name}`;
  const digest = createHash('sha256').update(tag.toLowerCase(), 'utf8').digest();
  return digest.subarray(0, 16);
}

/** The 2-hex-char channel hash (first byte of SHA-256(key)) used as a wire-format channel selector. */
export function channelHashForKey(key16) {
  return createHash('sha256').update(key16).digest()[0].toString(16).padStart(2, '0');
}
