import { compileSchema } from '../validation/ajv.js';
import { assertRegionInput } from '../regions/region-validation.js';
import { regionObservedAnswerSchema } from '../regions/region-schemas.js';
import { regionPublicationSourceSchema,regionPublicationPayloadSchema } from './region-publication-schemas.js';

const sourceValid=compileSchema(regionPublicationSourceSchema),payloadValid=compileSchema(regionPublicationPayloadSchema);
export function buildRegionPublication(input) {
  if(!sourceValid(input)) throw new Error('Invalid region publication source');
  assertRegionInput(regionObservedAnswerSchema,input.answer);
  const { answer }=input;
  // Unknown completeness always takes the conservative public hint. No
  // response-size heuristic can establish that the repeater omitted nothing.
  const payload={ type:'REGIONS',timestamp:new Date(answer.observedAt).toISOString(),
    target:input.targetPublicKey.toLowerCase(),regions:[...answer.regions],truncated:true,
    ...(answer.repeaterClock===null?{}:{ repeater_clock:answer.repeaterClock }) };
  if(!payloadValid(payload)) throw new Error('Invalid region publication payload');
  return { topic:`meshcore/client/${input.observerPublicKey.toLowerCase()}/regions`,payload };
}
