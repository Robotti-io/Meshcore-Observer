export const STATUS_TOPIC_TEMPLATE = 'meshcore/{IATA}/{PUBLIC_KEY}/status';
export const PACKETS_TOPIC_TEMPLATE = 'meshcore/{IATA}/{PUBLIC_KEY}/packets';

export class UnresolvedTopicVariableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnresolvedTopicVariableError';
  }
}

/**
 * Expands a `{VAR}` template against `vars`. Every template variable must
 * have a non-empty value; publishing to a topic with a leftover `{...}`
 * placeholder would be a silent, hard-to-notice bug, so this throws instead.
 */
export function resolveTopic(template, vars) {
  return template.replace(/\{([A-Z_]+)\}/g, (match, name) => {
    const value = vars[name];
    if (value === undefined || value === null || value === '') {
      throw new UnresolvedTopicVariableError(`Topic template "${template}" is missing a value for "${name}"`);
    }
    return String(value);
  });
}
