import { NodeJSSerialConnection } from '@liamcottle/meshcore.js';
import { waitForConnection } from './connect-helpers.js';

const SERIAL_OPEN_TIMEOUT_MS = 5000;

/**
 * Opens a serial Companion connection, trying each candidate port in order.
 * Startup must tolerate Windows exposing the serial device before the
 * Heltec Companion interface is fully responsive, so a slow/absent port is
 * treated as a normal failure for the caller's retry/backoff loop to handle,
 * not thrown as a fatal error.
 *
 * @param {{serialPorts: string[], logger: object, createConnection?: (port: string) => object}} options
 * `createConnection` defaults to the real NodeJSSerialConnection and exists
 * so the candidate-ports retry loop can be tested with a fake connection,
 * without requiring real hardware (see docs/project_plan.spec.md Section 27).
 * @returns the connected meshcore.js Connection instance
 * @throws if none of the candidate ports opened within the timeout
 */
export async function openSerialConnection({ serialPorts, logger, createConnection = (port) => new NodeJSSerialConnection(port) }) {
  let lastError = new Error('no serial ports configured');

  for (const port of serialPorts) {
    logger.debug('services.radio.serial', 'attempting serial connection', { port });
    const connection = createConnection(port);

    try {
      const connected = waitForConnection(connection, SERIAL_OPEN_TIMEOUT_MS);
      await connection.connect();
      await connected;
      logger.info('services.radio.serial', 'serial port opened', { port });
      return connection;
    } catch (err) {
      lastError = err;
      logger.warn('services.radio.serial', 'failed to open serial port', {
        port,
        error: err.message
      });
      try {
        await connection.close();
      } catch {
        // already unusable; nothing to clean up
      }
    }
  }

  throw lastError;
}
