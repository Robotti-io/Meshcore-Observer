import { Constants } from '@liamcottle/meshcore.js';
import { compileSchema, formatErrors } from '../validation/ajv.js';

const SIGN_CHUNK_BYTES = 128;
export const SIGN_COMMAND_TIMEOUT_MS = 10000;

const signingStartResponseSchema = {
  $id: 'meshcore-observer/radio/companion-signing-start-response',
  type: 'object', additionalProperties: false, required: ['reserved', 'maxSignDataLen'],
  properties: {
    reserved: { type: 'integer', minimum: 0, maximum: 255 },
    maxSignDataLen: { type: 'integer', minimum: 0, maximum: 4294967295 }
  }
};

const signingSignatureResponseSchema = {
  $id: 'meshcore-observer/radio/companion-signing-signature-response',
  type: 'object', additionalProperties: false, required: ['signature'],
  properties: {
    signature: {
      type: 'array', minItems: 64, maxItems: 64,
      items: { type: 'integer', minimum: 0, maximum: 255 }
    }
  }
};

const signingErrorResponseSchema = {
  $id: 'meshcore-observer/radio/companion-signing-error-response',
  type: 'object', additionalProperties: false, required: ['errCode'],
  properties: {
    errCode: { anyOf: [{ type: 'integer', minimum: 0, maximum: 255 }, { type: 'null' }] }
  }
};

const validateSigningStartResponse = compileSchema(signingStartResponseSchema);
const validateSigningSignatureResponse = compileSchema(signingSignatureResponseSchema);
const validateSigningErrorResponse = compileSchema(signingErrorResponseSchema);

/**
 * Signs bytes using the SDK's Companion command writers. The SDK's sign()
 * helper leaves an OK listener installed after signing, which can issue an
 * out-of-queue SIGN_FINISH when a later Companion command returns OK.
 *
 * @param {object} connection Active SDK connection owned by RadioManager.
 * @param {Buffer} data Bytes to sign.
 * @param {AbortSignal} signal Connection-generation cancellation signal.
 * @returns {Promise<Buffer>} Device-generated Ed25519 signature.
 */
export function signWithCompanion(connection, data, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let offset = 0;
    let phase = 'start';

    const cleanup = () => {
      connection.off(Constants.ResponseCodes.Ok, onOk);
      connection.off(Constants.ResponseCodes.Err, onError);
      connection.off(Constants.ResponseCodes.SignStart, onSignStart);
      connection.off(Constants.ResponseCodes.Signature, onSignature);
      signal.removeEventListener('abort', onAbort);
    };

    const finish = (error, signature) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(signature);
    };

    const writeCommand = async (operation, description) => {
      try {
        await operation();
      } catch (error) {
        finish(new Error(`Failed to send Companion signing ${description} command`, { cause: error }));
      }
    };

    const sendNextChunk = () => {
      const chunk = data.subarray(offset, Math.min(offset + SIGN_CHUNK_BYTES, data.length));
      offset += chunk.length;
      void writeCommand(() => connection.sendCommandSignData(chunk), 'data');
    };

    const onOk = () => {
      if (settled || phase !== 'data') return;
      if (offset < data.length) {
        sendNextChunk();
        return;
      }

      phase = 'signature';
      void writeCommand(() => connection.sendCommandSignFinish(), 'finish');
    };

    const onError = (response) => {
      if (settled) return;
      if (!validateSigningErrorResponse(response)) {
        finish(new Error(`Invalid Companion signing error response: ${formatErrors(validateSigningErrorResponse.errors)}`));
        return;
      }

      const detail = response.errCode === null ? '' : ` with device error code ${response.errCode}`;
      finish(new Error(`Companion rejected on-device signing${detail}`));
    };

    const onSignStart = (response) => {
      if (settled || phase !== 'start') return;
      if (!validateSigningStartResponse(response)) {
        finish(new Error(`Invalid Companion signing start response: ${formatErrors(validateSigningStartResponse.errors)}`));
        return;
      }
      if (data.length > response.maxSignDataLen) {
        finish(new Error('Companion signing input exceeds the device limit'));
        return;
      }

      phase = 'data';
      sendNextChunk();
    };

    const onSignature = (response) => {
      if (settled || phase !== 'signature') return;
      const signature = response?.signature instanceof Uint8Array
        ? Array.from(response.signature) : response?.signature;
      const normalized = { signature };
      if (!validateSigningSignatureResponse(normalized)) {
        finish(new Error(`Invalid Companion signature response: ${formatErrors(validateSigningSignatureResponse.errors)}`));
        return;
      }

      finish(null, Buffer.from(signature));
    };

    const onAbort = () => finish(signal.reason ?? new Error('Companion signing was cancelled'));

    if (signal.aborted) {
      onAbort();
      return;
    }

    // Use on/off pairs rather than once() so cleanup removes the exact
    // callback identity on every success and failure path.
    connection.on(Constants.ResponseCodes.Ok, onOk);
    connection.on(Constants.ResponseCodes.Err, onError);
    connection.on(Constants.ResponseCodes.SignStart, onSignStart);
    connection.on(Constants.ResponseCodes.Signature, onSignature);
    signal.addEventListener('abort', onAbort, { once: true });
    void writeCommand(() => connection.sendCommandSignStart(), 'start');
  });
}
