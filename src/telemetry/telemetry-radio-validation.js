import { compileSchema } from '../validation/ajv.js';
import * as schemas from './telemetry-radio-schemas.js';

const validators = new Map(Object.entries(schemas).filter(([name]) => name.endsWith('Schema'))
  .map(([, schema]) => [schema, compileSchema(schema)]));

export function isTelemetryRadioInput(schema, value) {
  return validators.get(schema)?.(value) === true;
}
export function assertTelemetryRadioInput(schema, value) {
  if (!isTelemetryRadioInput(schema, value)) throw new Error('Invalid telemetry radio data');
}
export function checkedTelemetryRadioResult(schema, value) {
  assertTelemetryRadioInput(schema, value);
  return value;
}
