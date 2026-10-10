// Synthetic post-tag host bodies based on MeshCore a366955 and CayenneLPP
// 1.6.1 (8ac5a60). No captured RF, deployed-version or permission evidence.
// Keep byte fixtures independent of the production field/width tables.
export const telemetryWire = Object.freeze({
  status48: 'E40C020092FFB5FF040302014433221158020000805101000A0000000B0000000C0000000D0000000300F0FF02000500',
  status56: 'E40C020092FFB5FF040302014433221158020000805101000A0000000B0000000C0000000D0000000300F0FF02000500E803000011000000',
  sensors: '0174014A0175007B026700FA036832047303F5',
  // Arbitrary nine GPS value bytes, used only to prove exclusion/width checks.
  excludedGps: '0188112233445566778899',
  neighbours: '01000100112233445566778805000000F0'
});

export function telemetryBytes(hex, padding = 0) {
  return [...Buffer.from(hex, 'hex'), ...Array(padding).fill(0)];
}

export function telemetryInput(component, body, options = {}) {
  const variant = component === 'status' ? { component, params: {},
    profile: { layout: options.layout ?? 'common48', evidence: options.evidence ?? 'established' } }
    : component === 'sensors' ? { component, params: { permissionMask: options.permissionMask ?? 0 } }
      : { component, params: { version: 0, count: options.count ?? 8, offset: options.offset ?? 0,
        orderBy: options.orderBy ?? 0, prefixLength: options.prefixLength ?? 8 } };
  return { response: { variant, body, ...(component === 'sensors'
    ? { emitterProfile: options.emitterProfile ?? 'positive-channels' } : {}) }, observedAt: options.observedAt ?? 1500 };
}

export function neighbourPage(entries, { total = entries.length, prefixLength = 8, padding = 0 } = {}) {
  const bytes = Buffer.alloc(4 + entries.length * (prefixLength + 5) + padding);
  bytes.writeUInt16LE(total, 0); bytes.writeUInt16LE(entries.length, 2);
  for (const [order, entry] of entries.entries()) {
    const start = 4 + order * (prefixLength + 5);
    Buffer.from(entry.prefix, 'hex').copy(bytes, start);
    bytes.writeUInt32LE(entry.age, start + prefixLength);
    bytes.writeInt8(entry.snr, start + prefixLength + 4);
  }
  return [...bytes];
}
