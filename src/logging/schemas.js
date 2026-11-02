export const requestInfoSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['requestID', 'hostname'],
  properties: {
    requestID: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' },
    hostname: { type: 'string', minLength: 1, maxLength: 255 },
    path: { type: 'string', maxLength: 256 },
    method: { type: 'string', minLength: 1, maxLength: 32 },
    ip: { type: 'string', maxLength: 128 },
    requestTime: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }
  }
};
