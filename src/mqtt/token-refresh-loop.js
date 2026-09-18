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
 * @returns a function that stops the loop.
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
  const timer = setInterval(() => {
    const expiresAt = auth.getExpiration();
    if (expiresAt === null) {
      return;
    }

    const nowSeconds = Math.floor(now() / 1000);
    if (nowSeconds < expiresAt - thresholdSeconds) {
      return;
    }

    auth
      .refreshIfNeeded({ thresholdSeconds })
      .then(async () => {
        logger.info('services.mqtt.letsmesh', 'reconnecting broker with a refreshed token');
        await broker.close();
        broker.connect(will);
      })
      .catch((err) => {
        logger.warn('services.mqtt.letsmesh', 'token refresh failed', { error: err.message });
      });
  }, checkIntervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
