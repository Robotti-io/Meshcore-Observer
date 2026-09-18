import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHmac } from 'node:crypto';
import { decryptGroupText } from '../../src/bots/group-text-crypto.js';
import { channelHashForKey } from '../../src/bots/channel-key.js';

// Test-only inverse of decryptGroupText, used purely to construct fixtures;
// production code never encrypts GRP_TXT itself (sending goes through the
// device's own sendChannelTextMessage, which encrypts on-device).
function encryptGroupText({ key16, timestamp, flags, text }) {
  const header = Buffer.alloc(5);
  header.writeUInt32LE(timestamp, 0);
  header[4] = flags;
  const body = Buffer.concat([header, Buffer.from(text, 'utf8'), Buffer.from([0])]);
  const paddedLength = Math.ceil(body.length / 16) * 16;
  const plaintext = Buffer.concat([body, Buffer.alloc(paddedLength - body.length)]);

  const cipher = createCipheriv('aes-128-ecb', key16, null);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const key32 = Buffer.concat([key16, Buffer.alloc(16)]);
  const mac = createHmac('sha256', key32).update(ciphertext).digest().subarray(0, 2);

  return { ciphertext, mac };
}

// Real vector from the reference Python observer's test suite
// (tests/packet_capture/test_payload_decode_export.py), itself sourced from
// https://github.com/michaelhart/meshcore-decoder - an independent
// cross-check that this Node port's crypto is byte-for-byte correct before
// it's relied on for the echo bot's on-air replies.
const BOT_KEY_16 = Buffer.from('eb50a1bcb3e4e5d7bf69a57c9dada211', 'hex');
const GRP_RAW = '1540cab3b15626481a5ba64247ab25766e410b026e0678a32da9f0c3946fae5b714cab170f';

function payloadFromRawFrame(rawHex) {
  // Skip header(1) + pathLen(1) bytes; this fixture has 0 path hops.
  return Buffer.from(rawHex, 'hex').subarray(2);
}

test('decrypts the real cross-referenced GRP_TXT vector correctly', () => {
  const payload = payloadFromRawFrame(GRP_RAW);
  const channelHash = payload.subarray(0, 1).toString('hex');
  const cipherMac = payload.subarray(1, 3);
  const ciphertext = payload.subarray(3);

  assert.equal(channelHash, 'ca');
  assert.equal(channelHashForKey(BOT_KEY_16), 'ca');

  const result = decryptGroupText(ciphertext, cipherMac, BOT_KEY_16);
  assert.ok(result);
  assert.equal(result.sender, 'Howl 👾');
  assert.equal(result.text, 'prefix 0101');
});

test('rejects the same ciphertext when the MAC has been tampered with', () => {
  const payload = payloadFromRawFrame(GRP_RAW);
  const cipherMac = Buffer.from(payload.subarray(1, 3));
  cipherMac[0] ^= 0xff; // flip a byte
  const ciphertext = payload.subarray(3);

  const result = decryptGroupText(ciphertext, cipherMac, BOT_KEY_16);
  assert.equal(result, null);
});

test('rejects decryption with the wrong key', () => {
  const payload = payloadFromRawFrame(GRP_RAW);
  const cipherMac = payload.subarray(1, 3);
  const ciphertext = payload.subarray(3);
  const wrongKey = Buffer.alloc(16, 0x42);

  const result = decryptGroupText(ciphertext, cipherMac, wrongKey);
  assert.equal(result, null);
});

test('rejects a ciphertext that is not a multiple of the AES block size', () => {
  const result = decryptGroupText(Buffer.alloc(17), Buffer.from([0, 0]), BOT_KEY_16);
  assert.equal(result, null);
});

test('returns text unchanged with no sender when there is no "name: " prefix', () => {
  const key16 = Buffer.alloc(16, 0x07);
  const { ciphertext, mac } = encryptGroupText({ key16, timestamp: 1700000000, flags: 0, text: 'no colon here' });

  const result = decryptGroupText(ciphertext, mac, key16);
  assert.ok(result);
  assert.equal(result.sender, null);
  assert.equal(result.text, 'no colon here');
  assert.equal(result.timestamp, 1700000000);
});

test('splits "sender: message" and round-trips a multi-block message', () => {
  const key16 = Buffer.alloc(16, 0x0a);
  const { ciphertext, mac } = encryptGroupText({
    key16,
    timestamp: 1700000042,
    flags: 3,
    text: 'Alice: this message is long enough to span more than one AES block'
  });

  const result = decryptGroupText(ciphertext, mac, key16);
  assert.ok(result);
  assert.equal(result.sender, 'Alice');
  assert.equal(result.text, 'this message is long enough to span more than one AES block');
  assert.equal(result.flags, 3);
});

test('does not treat a colon appearing after position 50 as a sender split', () => {
  const key16 = Buffer.alloc(16, 0x0b);
  const longPrefix = 'x'.repeat(60);
  const { ciphertext, mac } = encryptGroupText({
    key16,
    timestamp: 1,
    flags: 0,
    text: `${longPrefix}: message`
  });

  const result = decryptGroupText(ciphertext, mac, key16);
  assert.ok(result);
  assert.equal(result.sender, null);
  assert.equal(result.text, `${longPrefix}: message`);
});
