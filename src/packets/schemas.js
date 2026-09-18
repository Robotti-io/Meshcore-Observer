// Validates the normalized raw radio event - the trust boundary crossing
// point for over-the-air data, before any decoding happens.
export const rawPacketEventSchema = {
  $id: 'meshcore-observer/packets/raw-event',
  type: 'object',
  additionalProperties: false,
  required: ['receivedAt', 'snr', 'rssi', 'frameHex'],
  properties: {
    receivedAt: { type: 'string', minLength: 1 },
    snr: { type: 'number' },
    rssi: { type: 'number' },
    frameHex: { type: 'string', pattern: '^([0-9A-Fa-f]{2})*$' }
  }
};
