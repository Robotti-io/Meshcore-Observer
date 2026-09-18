import { test } from 'node:test';
import assert from 'node:assert/strict';

// Windows delivers process termination very differently from POSIX (no real
// signals), so this exercises the shutdown handler's own logic directly by
// emitting the event Node registers for, rather than relying on an external
// OS-level signal reaching the process.
test('logs a clean shutdown when SIGINT is received', async () => {
  // Uses a TCP target expected to refuse the connection immediately, so the
  // radio manager's background connect attempt fails fast rather than
  // waiting out its full open-timeout. This intentionally exercises the
  // real entrypoint wiring (not a fake transport) without needing hardware.
  process.env.PACKETCAPTURE_CONNECTION_TYPE = 'tcp';
  process.env.PACKETCAPTURE_TCP_HOST = '127.0.0.1';
  process.env.PACKETCAPTURE_TCP_PORT = '1';
  process.env.PACKETCAPTURE_IATA = 'CVG';

  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);

  try {
    await import('../src/index.js');
    process.emit('SIGINT');
    // shutdown() is async (it awaits radioManager.stop()); process.emit does
    // not wait for its listener's returned promise, so give it a moment to
    // actually finish before asserting on what it logged.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    console.log = originalLog;
  }

  const messages = lines.map((line) => JSON.parse(line).message);
  assert.ok(messages.includes('meshcore-observer starting'));
  assert.ok(messages.includes('shutdown signal received'));
  assert.ok(messages.includes('meshcore-observer stopped'));
  assert.equal(process.exitCode, 0);
});
