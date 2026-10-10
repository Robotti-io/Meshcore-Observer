import { TextDecoder } from 'node:util';
import { compileSchema } from '../validation/ajv.js';
import { regionBodySchema, regionAnswerSchema, regionObservedAnswerSchema, regionOutcomeSchema, regionResultSchema,
  regionLatestQuerySchema, regionAnswerPageSchema, regionOutcomePageSchema, regionPublicationPageSchema,
  regionStagePublicationsSchema, regionClaimPublicationSchema, regionResolvePublicationSchema } from './region-schemas.js';

const schemas = [regionBodySchema, regionAnswerSchema, regionObservedAnswerSchema, regionOutcomeSchema, regionResultSchema,
  regionLatestQuerySchema, regionAnswerPageSchema, regionOutcomePageSchema, regionPublicationPageSchema,
  regionStagePublicationsSchema, regionClaimPublicationSchema, regionResolvePublicationSchema];
const validators = new Map(schemas.map(schema => [schema, compileSchema(schema)]));
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const invalid = () => new Error('Invalid region data'); // Never echo values/unknown fields.

function assertAnswerSemantics(answer) {
  const csv = answer.regions.join(',');
  const encoded = Buffer.from(csv, 'utf8');
  // AJV bounds strings/items; these cross-field byte constraints and UTF-16
  // round-trip checks cannot be expressed by the standard JSON Schema dialect.
  if (utf8.decode(encoded) !== csv || encoded.length !== answer.csvBytes
    || answer.bodyBytes < 4 + answer.csvBytes) throw invalid();
}

/** Only central, known schemas; AJV always precedes semantic processing. */
export function assertRegionInput(schema, value) {
  if (validators.get(schema)?.(value) !== true) throw invalid();
  if (schema === regionAnswerSchema || schema === regionObservedAnswerSchema) assertAnswerSemantics(value);
  if (schema === regionResultSchema) {
    if (value.answer) assertAnswerSemantics(value.answer);
    const { startedAt, completedAt, clockAnomaly } = value.outcome;
    if (!clockAnomaly && (completedAt < startedAt || (value.answer
      && (value.answer.observedAt < startedAt || value.answer.observedAt > completedAt)))) throw invalid();
  }
  if (schema === regionOutcomeSchema && !value.clockAnomaly && value.completedAt < value.startedAt) throw invalid();
  if ((schema === regionAnswerPageSchema || schema === regionOutcomePageSchema) && value.start > value.end) throw invalid();
  if (schema === regionResolvePublicationSchema && value.status === 'pending' && value.nextDueAt < value.resolvedAt) throw invalid();
}

export function assertRegionAnswer(answer) { assertRegionInput(regionAnswerSchema, answer); }
export function assertRegionResult(result) { assertRegionInput(regionResultSchema, result); }
