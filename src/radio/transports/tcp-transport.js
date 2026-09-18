import { TCPConnection } from '@liamcottle/meshcore.js';
import { waitForConnection } from './connect-helpers.js';

const TCP_CONNECT_TIMEOUT_MS = 5000;

/**
 * Opens a TCP Companion connection. This is the transport used once the
 * radio is reached through a serial-to-TCP bridge (e.g. in a containerized
 * deployment); higher-level code must not need to know which transport is
 * in use.
 *
 * `timeoutMs` is overridable purely for testing against a real local
 * socket that deliberately never completes the Companion handshake
 * (see test/radio/transports/tcp-transport.test.js), without slowing every
 * real connection attempt's default timeout.
 *
 * @returns the connected meshcore.js Connection instance
 * @throws if the connection does not establish within the timeout
 */
export async function openTcpConnection({ host, port, logger, timeoutMs = TCP_CONNECT_TIMEOUT_MS }) {
  logger.debug('services.radio.tcp', 'attempting tcp connection', { host, port });
  const connection = new TCPConnection(host, port);

  try {
    const connected = waitForConnection(connection, timeoutMs);
    await connection.connect();
    await connected;
    logger.info('services.radio.tcp', 'tcp connection opened', { host, port });
    return connection;
  } catch (err) {
    logger.warn('services.radio.tcp', 'failed to open tcp connection', {
      host,
      port,
      error: err.message
    });
    try {
      await connection.close();
    } catch {
      // already unusable; nothing to clean up
    }
    throw err;
  }
}
