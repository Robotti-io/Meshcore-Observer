import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { openTcpConnection } from '../../../src/radio/transports/tcp-transport.js';

function silentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('rejects quickly when the connection is refused (nothing listening)', async () => {
  // Port 1 is a privileged/unassigned port essentially guaranteed to have
  // nothing listening, so the OS refuses the connection immediately.
  await assert.rejects(
    openTcpConnection({ host: '127.0.0.1', port: 1, logger: silentLogger() }),
    /closed before it was ready/
  );
});

// meshcore.js's Connection.onConnected() awaits an internal deviceQuery
// round-trip (with no timeout of its own) before ever emitting "connected",
// so a real socket that accepts the TCP connection but never speaks the
// Companion protocol - exactly what a plain net.Server stand-in is - hangs
// until openTcpConnection's own timeout fires. This is real, correct
// behavior (Section 9's "tolerate a slow/absent port" requirement), not a
// bug; a short injected timeoutMs keeps this test fast rather than waiting
// out the real 5s default.
test('times out (rather than hanging forever) against a real socket that never completes the handshake', async () => {
  const server = createServer((socket) => socket.on('data', () => {}));
  const port = await listen(server);

  try {
    await assert.rejects(
      openTcpConnection({ host: '127.0.0.1', port, logger: silentLogger(), timeoutMs: 100 }),
      /Timed out waiting for connection/
    );
  } finally {
    await closeServer(server);
  }
});

test('closes the underlying socket after a failed attempt', async () => {
  const server = createServer((socket) => socket.on('data', () => {}));
  const port = await listen(server);
  let acceptedSocket;
  server.on('connection', (socket) => {
    acceptedSocket = socket;
  });

  try {
    await assert.rejects(openTcpConnection({ host: '127.0.0.1', port, logger: silentLogger(), timeoutMs: 100 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acceptedSocket.destroyed, true);
  } finally {
    await closeServer(server);
  }
});
