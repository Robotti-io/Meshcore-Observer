/**
 * Builds the retained observer status payload (see
 * docs/project_plan.spec.md Section 18). `deviceInfo` is RadioManager's
 * normalized device info (publicKey, name, model, firmwareVersion, radio).
 */
export function buildObserverStatusPayload({ deviceInfo, clientVersion, status, now = () => new Date() }) {
  const radio = deviceInfo.radio
    ? `${(deviceInfo.radio.frequency / 1000).toFixed(3)}MHz BW${(deviceInfo.radio.bandwidth / 1000).toFixed(1)}kHz SF${deviceInfo.radio.spreadingFactor} CR${deviceInfo.radio.codingRate}`
    : null;

  return {
    status,
    timestamp: now().toISOString(),
    origin: deviceInfo.name,
    origin_id: deviceInfo.publicKey.toUpperCase(),
    model: deviceInfo.model ?? null,
    firmware_version: deviceInfo.firmwareVersion ?? null,
    radio,
    client_version: clientVersion
  };
}
