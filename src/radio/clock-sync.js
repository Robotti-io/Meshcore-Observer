/**
 * Reads the Companion device's clock and advances it to the system clock
 * only if the device is behind. Never moves the device clock backward.
 * Failure is logged as a warning and must not abort observer startup.
 */
export async function syncDeviceClock({ connection, commandQueue, logger, now = () => Date.now() }) {
  try {
    const { epochSecs } = await commandQueue.run(() => connection.getDeviceTime());
    const systemEpochSecs = Math.floor(now() / 1000);

    if (epochSecs < systemEpochSecs) {
      await commandQueue.run(() => connection.setDeviceTime(systemEpochSecs));
      logger.info('services.radio', 'device clock updated', {
        previousEpochSecs: epochSecs,
        newEpochSecs: systemEpochSecs
      });
    } else {
      logger.debug('services.radio', 'device clock already current', {
        deviceEpochSecs: epochSecs,
        systemEpochSecs
      });
    }
  } catch (err) {
    logger.warn('services.radio', 'clock sync failed', { error: err.message });
  }
}
