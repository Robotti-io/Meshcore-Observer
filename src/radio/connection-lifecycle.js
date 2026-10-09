const messages = {
  'not-connected': 'radio is not connected',
  'not-ready': 'radio connection handshake is not ready',
  'stale-generation': 'radio command belongs to a retired connection generation',
  disconnected: 'radio disconnected before the command completed',
  stopped: 'radio stopped before the command completed',
  invalidated: 'radio connection was reset before the command completed',
  'connect-failed': 'radio connection setup failed before the command completed',
  'close-failed': 'Radio connection close failed; verify the transport is closed and restart Observer.',
  'close-timeout': 'Radio connection closure was not confirmed; verify the transport is closed and restart Observer.',
  'open-timeout': 'Radio transport opening did not settle during shutdown; verify the transport is closed and restart Observer.'
};

export class RadioConnectionError extends Error {
  constructor(code) {
    super(messages[code]);
    this.name = 'RadioConnectionError';
    this.code = code;
  }
}

/** close() returning is not proof of closure in installed serial firmware APIs. */
export function closeConnection(connection, timeoutMs, disconnectedEvidence) {
  return new Promise((resolve) => {
    let finished = false;
    const onDisconnected = () => finish('closed');
    const timer = setTimeout(() => finish('close-timeout'), timeoutMs);
    function finish(status) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      connection.off('disconnected', onDisconnected);
      resolve(status);
    }
    connection.on('disconnected', onDisconnected);
    // The SDK may have queued the generation's earlier disconnect listener
    // before this close listener was attached. That captured evidence is
    // still authoritative for this connection, never for its replacement.
    disconnectedEvidence.then(onDisconnected);
    try {
      // Consume both late settlement paths even if disconnection wins first.
      Promise.resolve(connection.close()).then(() => {}, () => finish('close-failed'));
    } catch {
      finish('close-failed');
    }
  });
}

export function waitForSettlement(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const settled = () => { clearTimeout(timer); resolve(true); };
    promise.then(settled, settled);
  });
}
