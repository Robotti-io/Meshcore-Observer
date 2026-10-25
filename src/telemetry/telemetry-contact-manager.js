import { compileSchema } from '../validation/ajv.js';
import { Constants } from '@liamcottle/meshcore.js';

const key = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9A-F]{64}$' };
const uint32 = { type: 'integer', minimum: 0, maximum: 0xFFFFFFFF };
const contact = { type: 'object', additionalProperties: false,
  required: ['publicKey', 'contactType', 'flags', 'encodedPathLength', 'pathBytes', 'name', 'lastAdvert', 'lat', 'lon', 'lastMod'],
  properties: { publicKey: key, contactType: { type: 'integer', minimum: 0, maximum: 255 }, flags: { type: 'integer', minimum: 0, maximum: 255 },
    encodedPathLength: { type: 'integer', minimum: 0, maximum: 255 }, pathBytes: { type: 'array', minItems: 64, maxItems: 64, items: { type: 'integer', minimum: 0, maximum: 255 } },
    name: { type: 'string', maxLength: 32 }, lastAdvert: uint32,
    lat: { type: 'integer', minimum: -2147483648, maximum: 2147483647 }, lon: { type: 'integer', minimum: -2147483648, maximum: 2147483647 }, lastMod: uint32 } };
const route = { type: 'object', additionalProperties: false,
  required: ['status', 'target', 'path', 'hashWidth', 'receivedAt', 'receptionCount'],
  properties: { status: { const: 'available' }, target: { type: 'object', additionalProperties: false,
    required: ['publicKeyHex', 'name', 'flags', 'advertTimestamp', 'lat', 'lon'], properties: { publicKeyHex: key,
      name: { type: ['string', 'null'], maxLength: 32 }, flags: { type: 'integer', minimum: 0, maximum: 255 },
      advertTimestamp: uint32, lat: { type: ['integer', 'null'], minimum: -2147483648, maximum: 2147483647 },
      lon: { type: ['integer', 'null'], minimum: -2147483648, maximum: 2147483647 } } },
  path: { type: 'array', maxItems: 31, items: { type: 'string', pattern: '^[0-9A-F]{4}$' } }, hashWidth: { const: 2 },
  receivedAt: { type: 'integer', minimum: 0 }, receptionCount: { type: 'integer', minimum: 1 },
  evidenceSource: { enum: ['verified-advert', 'passive-topology', 'telemetry-neighbours'] },
  hopWeights: { type: 'array', maxItems: 31, items: { type: 'object', additionalProperties: false,
    required: ['position', 'repeaterId', 'anchorSuccessCount', 'pathReceptionCount'], properties: {
      position: { type: 'integer', minimum: 1, maximum: 31 }, repeaterId: { type: 'string', pattern: '^[0-9A-F]{4}$' },
      anchorSuccessCount: { type: 'integer', minimum: 0 }, pathReceptionCount: { type: 'integer', minimum: 0 },
      traceSuccessCount: { type: 'integer', minimum: 0 }, neighbourSupportCount: { type: 'integer', minimum: 0 }
    } } } } };
const inputSchema = { $id: 'meshcore-observer/telemetry/contact-sync-input', type: 'object', additionalProperties: false,
  required: ['targetPublicKey', 'contacts', 'route'], properties: { targetPublicKey: key,
    contacts: { type: 'array', maxItems: 1024, items: contact }, route: { anyOf: [route, { type: 'null' }] } } };
const validate = compileSchema(inputSchema);

async function withResponseError(connection, operation) {
  let responseError = null;
  const onError = event => { responseError = event?.errCode ?? null; };
  connection.once(Constants.ResponseCodes.Err, onError);
  try { await operation(); }
  catch (error) {
    const failure = error instanceof Error ? error : new Error('MeshCore contact command failed');
    failure.meshcoreErrorCode = responseError;
    throw failure;
  }
  finally { connection.off(Constants.ResponseCodes.Err, onError); }
}

/** Reconcile from fresh route evidence; only a confirmed TABLE_FULL may evict a contact. */
export async function reconcileTelemetryContact({ connection, targetPublicKey, contacts, route: inferredRoute }) {
  const input = { targetPublicKey, contacts, route: inferredRoute };
  if (!validate(input)) throw new Error('Invalid telemetry contact reconciliation input');
  if (inferredRoute === null || inferredRoute.target.publicKeyHex !== targetPublicKey) return { status: 'deferred', reason: 'route-unavailable' };
  const current = contacts.find(item => item.publicKey === targetPublicKey);
  const pathBytes = inferredRoute.path.flatMap(prefix => [Number.parseInt(prefix.slice(0, 2), 16), Number.parseInt(prefix.slice(2), 16)]);
  const encodedPathLength = pathBytes.length === 0 ? 0 : 0x40 | inferredRoute.path.length;
  const preserveContactMetadata = inferredRoute.evidenceSource !== 'verified-advert' && current;
  const targetFlags = preserveContactMetadata ? current.flags : inferredRoute.target.flags;
  const targetName = (preserveContactMetadata ? current.name : inferredRoute.target.name) ?? '';
  const targetLastAdvert = preserveContactMetadata ? current.lastAdvert : inferredRoute.target.advertTimestamp;
  const targetLat = (preserveContactMetadata ? current.lat : inferredRoute.target.lat) ?? 0;
  const targetLon = (preserveContactMetadata ? current.lon : inferredRoute.target.lon) ?? 0;
  if (current && current.contactType === 2 && current.encodedPathLength === encodedPathLength
    && current.pathBytes.slice(0, pathBytes.length).every((value, index) => value === pathBytes[index])
    && current.flags === targetFlags && current.name === targetName
    && current.lastAdvert === targetLastAdvert && current.lat === targetLat && current.lon === targetLon) {
    return { status: 'unchanged', hopCount: inferredRoute.path.length };
  }
  const paddedPath = new Uint8Array(64); paddedPath.set(pathBytes);
  const upsert = () => connection.addOrUpdateContact(Buffer.from(targetPublicKey, 'hex'), 2, targetFlags,
    encodedPathLength, paddedPath, targetName, targetLastAdvert, targetLat, targetLon);
  try { await withResponseError(connection, upsert); }
  catch (error) {
    // MeshCore ERR_CODE_TABLE_FULL = 3. Never delete a contact on generic
    // transport, validation, unsupported-command, or filesystem failures.
    if (current || error.meshcoreErrorCode !== 3) throw error;
    const victim = contacts.filter(item => item.publicKey !== targetPublicKey && (item.flags & 0x01) === 0)
      .sort((a, b) => a.lastMod - b.lastMod || a.publicKey.localeCompare(b.publicKey))[0];
    if (!victim) throw error;
    await withResponseError(connection, () => connection.removeContact(Buffer.from(victim.publicKey, 'hex')));
    await withResponseError(connection, upsert);
    return { status: 'added', hopCount: inferredRoute.path.length, evicted: true };
  }
  return { status: current ? 'updated' : 'added', hopCount: inferredRoute.path.length, evicted: false };
}
