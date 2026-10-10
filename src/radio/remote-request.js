import { compileSchema, formatErrors } from '../validation/ajv.js';
import { remoteRequestSchema, remoteRequestUniquenessSchema } from './remote-request-schemas.js';
import { prepareRegionAnonymousRequest } from '../regions/region-radio-adapter.js';

const requestValid = compileSchema(remoteRequestSchema);
const uniquenessValid = compileSchema(remoteRequestUniquenessSchema);

export function assertRemoteRequest(request) {
  if (!requestValid(request)) throw new Error(`Invalid remote request: ${formatErrors(requestValid.errors)}`);
}

/**
 * Prepare only the installed library's read-only binary command arguments.
 * No transport, contact, credential, timer or listener is touched here.
 * Callers generate the four uniqueness bytes; they do not choose a wire tag.
 */
export function prepareRemoteRequest(request, uniquenessBytes) {
  assertRemoteRequest(request);
  if (request.operation === 'anonymous-regions') {
    return { status: 'prepared', command: { commandCode: 57,
      frameBytes: prepareRegionAnonymousRequest({ targetPublicKey: request.targetPublicKey }) } };
  }
  if (!uniquenessValid(uniquenessBytes)) {
    throw new Error(`Invalid remote request uniqueness bytes: ${formatErrors(uniquenessValid.errors)}`);
  }

  let requestBytes;
  if (request.operation === 'status') {
    requestBytes = [0x01, 0, 0, 0, 0, ...uniquenessBytes];
  } else if (request.operation === 'telemetry') {
    // The repeater inverts this byte to select requested sensor permissions;
    // it cannot grant ACL rights that the sender does not already possess.
    requestBytes = [0x03, 255 - request.params.permissionMask, 0, 0, 0, ...uniquenessBytes];
  } else {
    const { count, offset, orderBy, prefixLength } = request.params;
    requestBytes = [0x06, 0, count, offset & 255, offset >> 8, orderBy, prefixLength, ...uniquenessBytes];
  }
  return { status: 'prepared', command: {
    commandCode: 50, targetPublicKey: request.targetPublicKey, requestBytes
  } };
}
