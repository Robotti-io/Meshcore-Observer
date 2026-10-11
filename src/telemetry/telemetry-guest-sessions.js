/** Ephemeral authority only. Durable server-time high-water is supplied by the
 * required owner callback; this cache cannot restore authority after restart. */
export function createTelemetryGuestSessions({ now, quarantineMs }) {
  const sessions = new Map(), retired = new Map();
  let scope = null, lastTime = 0;
  const time = () => {
    const sample = now();
    if (!Number.isFinite(sample) || sample < lastTime) { sessions.clear(); return null; }
    lastTime = sample;
    for (const [prefix, expires] of retired) if (expires <= sample) retired.delete(prefix);
    for (const [key, session] of sessions) if (session.expires <= sample) sessions.delete(key);
    return sample;
  };
  return Object.freeze({
    observe(snapshot) {
      const next = snapshot.ready && snapshot.generation !== null && snapshot.observerPublicKey
        ? `${snapshot.generation}:${snapshot.observerPublicKey.toUpperCase()}` : null;
      if (next !== scope || next === null) sessions.clear();
      scope = next;
      return time() !== null && scope !== null;
    },
    loginReason(key) {
      if (time() === null) return 'clock-anomaly';
      if (retired.has(key.slice(0, 8))) return 'login-quarantined';
      return retired.size >= 32 ? 'login-quarantine-full' : null;
    },
    retire(key) {
      sessions.delete(key);
      // Admission reserved a free slot and only one owner can retire at once.
      retired.set(key.slice(0, 8), lastTime + quarantineMs);
    },
    grant(key, config) {
      const current = time();
      if (current === null || scope === null) return false;
      if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
      sessions.set(key, { config, expires: current + config.sessionTtlMs });
      return true;
    },
    has(key, config) { return time() !== null && scope !== null && sessions.get(key)?.config === config; },
    revoke(key) { sessions.delete(key); },
    clear() { sessions.clear(); scope = null; }
  });
}
