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
  // The persisted data store now opens unconditionally at startup (see
  // src/index.js) - :memory: keeps this test from touching a real file on
  // disk regardless of PACKETCAPTURE_METRICS_UI_ENABLED.
  process.env.PACKETCAPTURE_METRICS_UI_DB_PATH = ':memory:';

  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);

  try {
    await import('../src/index.js');
    // main() now performs a real (if fast) dynamic import of the data
    // store during startup, unconditionally (see src/index.js) - it no
    // longer necessarily finishes registering its SIGINT handler
    // synchronously by the time this outer import() resolves. Poll for
    // that registration rather than assuming a fixed delay is enough -
    // emitting SIGINT before it's registered is a silent no-op, and
    // without a working shutdown() the radio reconnect loop's timers
    // (correctly not unref'd, so a real run keeps the process alive) would
    // hang this test forever instead of just failing it.
    for (let i = 0; i < 50 && process.listenerCount('SIGINT') === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(process.listenerCount('SIGINT') > 0, 'main() never registered its SIGINT handler');

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
