import { compileSchema } from '../validation/ajv.js';
import { telemetryOwnerCompletionSchema } from './telemetry-owner-schemas.js';
import { TELEMETRY_FAILURE_REASONS } from './telemetry-schemas.js';
import { assertTelemetryResult } from './telemetry-validation.js';
import { parseStatusResponseBody } from './status-parser.js';
import { parseSensorResponseBody } from './sensor-parser.js';
import { parseNeighbourResponseBody } from './neighbour-parser.js';

export const validateTelemetryCompletion = compileSchema(telemetryOwnerCompletionSchema);
const parsers = { status: parseStatusResponseBody, sensors: parseSensorResponseBody, neighbours: parseNeighbourResponseBody };

/** A dispatched, owned binary result only. Authentication never creates data. */
export function telemetryPollingResult({ response, reservation, variant, emitterProfile, completedAt, clockAnomaly }) {
  if (!validateTelemetryCompletion(response) || !response.context || response.dispatchedAt === undefined
    || !['completed', 'failed'].includes(response.status)) throw new Error('Invalid telemetry polling completion');
  const c = response.context;
  if (c.requestId !== reservation.requestId || c.observerPublicKey !== reservation.observerPublicKey
    || c.targetPublicKey !== reservation.targetPublicKey
    || c.operation !== (variant.component === 'sensors' ? 'telemetry' : variant.component)
    || JSON.stringify(c.params) !== JSON.stringify(variant.params)) throw new Error('Invalid telemetry polling ownership');
  clockAnomaly ||= response.dispatchedAt < reservation.reservedAt || completedAt < response.dispatchedAt
    || (response.receivedAt !== undefined && (response.receivedAt < response.dispatchedAt || response.receivedAt > completedAt));
  const parsed = response.status === 'completed' && response.route === 'direct'
    && response.tag !== undefined && response.receivedAt !== undefined
    ? parsers[variant.component]({ observedAt: response.receivedAt,
      response: { variant, body: response.body, ...(variant.component === 'sensors' ? { emitterProfile } : {}) } }) : null;
  const accepted = parsed?.status === 'accepted';
  const unsupported = response.reason === 'command-error' && response.errorReason === 'unsupported';
  const reason = accepted ? null : unsupported ? 'unsupported' : response.status === 'completed'
    ? 'malformed-response' : TELEMETRY_FAILURE_REASONS.includes(response.reason) ? response.reason : 'protocol-error';
  const result = { decoderVersion: 1, outcome: { requestId: reservation.requestId, runId: reservation.runId,
    observerPublicKey: reservation.observerPublicKey, targetPublicKey: reservation.targetPublicKey, variant,
    startedAt: response.dispatchedAt, completedAt, receivedAt: response.receivedAt ?? null, clockAnomaly,
    tag: response.tag ?? null, route: response.route ?? null,
    status: accepted ? parsed.observation.quality === 'decoded' ? 'answered' : 'partial' : unsupported ? 'unsupported' : 'failed', reason
  }, ...(accepted ? { observation: parsed.observation } : {}) };
  assertTelemetryResult(result);
  return result;
}
