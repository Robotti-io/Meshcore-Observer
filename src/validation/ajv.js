import Ajv from 'ajv';

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  removeAdditional: false
});

/**
 * Compiles a JSON Schema (additionalProperties: false expected) using the
 * repository's single shared, strictly-configured AJV instance. Centralizing
 * instantiation keeps validation strictness consistent across every schema
 * in the codebase.
 */
export function compileSchema(schema) {
  return ajv.compile(schema);
}

export function formatErrors(errors) {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '(root)'} ${error.message}`)
    .join('; ');
}
