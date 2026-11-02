const DEFAULT_CHECK_INTERVAL_MS = 60000;
const DEFAULT_THRESHOLD_SECONDS = 300;

/**
 * Periodically checks a LetsMeshAuth's current token and, once it's within
 * the renewal threshold, signs a fresh one and reconnects the broker with
 * it (MQTT.js's own reconnect logic reuses the credentials from the
 * original connect() call, so a token-auth broker that needs a fresh
 * credential has to close()/connect() again explicitly - see
 * mqtt-broker.js). A cheap timestamp check runs every `checkIntervalMs`;
 * the expensive on-device signing only happens once actually near expiry.
 *
 * Stop invalidates pending renewal continuations immediately. On-device
 * signing may finish later, but it cannot close or reconnect the broker.
 * @returns {() => void} an idempotent synchronous stop function.
 */
export function startTokenRefreshLoop({
  auth,
  broker,
  will,
  logger,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  thresholdSeconds = DEFAULT_THRESHOLD_SECONDS,
  now = () => Date.now()
}) {
  let stopped = false;
  let renewalPending = false;

  async function renew() {
    renewalPending = true;
    try {
      await auth.refreshIfNeeded({ thresholdSeconds });
      if (stopped) return;

      logger.info('services.mqtt.letsmesh', 'reconnecting broker with a refreshed token');
      await broker.close();
      if (stopped) return;

      broker.connect(will);
    } catch (err) {
      if (!stopped) {
        logger.warn('services.mqtt.letsmesh', 'token refresh failed', { error: err.message });
      }
    } finally {
      renewalPending = false;
    }
  }

  const timer = setInterval(() => {
    if (stopped || renewalPending) return;
    const expiresAt = auth.getExpiration();
    if (expiresAt === null) {
      return;
    }

    const nowSeconds = Math.floor(now() / 1000);
    if (nowSeconds < expiresAt - thresholdSeconds) {
      return;
    }

    void renew();
  }, checkIntervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
