import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { NodeJSSerialConnection, TCPConnection, Constants } from '@liamcottle/meshcore.js';
import { installTraceDecoder } from '../../src/radio/trace-decoder.js';

// Literal firmware layout, independent of the coordinator's command/fixtures:
// two hashes, two signed quarter-dB SNRs, then the receiver's SNR.
const trace = Buffer.from('8900040144332211000000009905AC01F810F4', 'hex');
afterEach(() => { assert.equal(vi.getTimerCount(), 0); vi.useRealTimers(); });
for (const kind of ['serial', 'tcp']) test(`${kind}: firmware two-byte trace decodes without SDK buffer errors and drains the next frame`, async () => {
  vi.useFakeTimers();
  const connection = kind === 'serial' ? new NodeJSSerialConnection('UNUSED') : new TCPConnection('unused', 0);
  const original = connection.onTraceDataPush;
  installTraceDecoder(connection);
  const decoded = [], raw = [], ok = [];
  connection.on(Constants.PushCodes.TraceData, value => decoded.push(value));
  connection.on('rx', value => raw.push(value));
  connection.on(Constants.ResponseCodes.Ok, value => ok.push(value));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const wire = Buffer.concat([Buffer.from([62, trace.length, 0]), trace, Buffer.from([62, 1, 0, 0])]);
    const feed = bytes => kind === 'serial' ? connection.onDataReceived(bytes) : connection.onSocketDataReceived(bytes);
    await feed(wire.subarray(0, 2)); await feed(wire.subarray(2));
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(errors.mock.calls.length, 0); assert.equal(raw.length, 2); assert.equal(ok.length, 1);
    assert.equal(decoded.length, 1);
    assert.deepEqual(decoded[0], { reserved: 0, pathLen: 4, flags: 1, tag: 0x11223344, authCode: 0,
      pathHashes: new Uint8Array([0x99, 5, 0xAC, 1]), pathSnrs: new Uint8Array([0xF8, 0x10]), lastSnr: -3 });
    assert.notEqual(connection.onTraceDataPush, original);
    const other = kind === 'serial' ? new NodeJSSerialConnection('UNUSED') : new TCPConnection('unused', 0);
    assert.equal(other.onTraceDataPush, original, 'never patch SDK prototypes');
  } finally { errors.mockRestore(); }
});

test('trace decoder ignores malformed layouts while preserving raw frame delivery', async () => {
  vi.useFakeTimers();
  const connection = new TCPConnection('unused', 0); installTraceDecoder(connection);
  const decoded = [], raw = [];
  connection.on(Constants.PushCodes.TraceData, value => decoded.push(value));
  connection.on('rx', value => raw.push(value));
  for (const bytes of [trace.subarray(0, -1), Buffer.concat([trace, Buffer.from([0])]),
    Buffer.from('8900040344332211000000009905AC01F810F4', 'hex'),
    Buffer.from('8900030144332211000000009905AC01F810F4', 'hex'),
    Buffer.from('8901040144332211000000009905AC01F810F4', 'hex')]) connection.onFrameReceived([...bytes]);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(raw.length, 5); assert.equal(decoded.length, 0);
});

test('trace decoder preserves one-byte trace events', async () => {
  vi.useFakeTimers();
  const connection = new TCPConnection('unused', 0); installTraceDecoder(connection);
  const decoded = [];
  connection.on(Constants.PushCodes.TraceData, value => decoded.push(value));
  connection.onFrameReceived([...Buffer.from('89000200443322110000000099ACF810F4', 'hex')]);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(decoded, [{ reserved: 0, pathLen: 2, flags: 0, tag: 0x11223344, authCode: 0,
    pathHashes: new Uint8Array([0x99, 0xAC]), pathSnrs: new Uint8Array([0xF8, 0x10]), lastSnr: -3 }]);
});
