/**
 * Resolves once `connection` emits "connected". Rejects immediately if it
 * emits "disconnected" first (a fast failure, e.g. TCP connection refused),
 * or after `timeoutMs` if neither fires (the only signal available for a
 * hung open, since meshcore.js's connect() calls do not reject on failure -
 * errors are only console.logged internally by the library).
 */
export function waitForConnection(connection, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for connection after ${timeoutMs}ms`));
    }, timeoutMs);

    function onConnected() {
      cleanup();
      resolve();
    }

    function onDisconnected() {
      cleanup();
      reject(new Error('connection closed before it was ready'));
    }

    function cleanup() {
      clearTimeout(timer);
      connection.off('connected', onConnected);
      connection.off('disconnected', onDisconnected);
    }

    connection.once('connected', onConnected);
    connection.once('disconnected', onDisconnected);
  });
}
