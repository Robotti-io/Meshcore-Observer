import { compileSchema } from '../validation/ajv.js';
import { requestInfoSchema } from './schemas.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const validateRequestInfo = compileSchema(requestInfoSchema);

const REDACTED = '[REDACTED]';

// Matches key names for any value that must never reach a log line, per the
// repository's logging contract (JWTs, MQTT passwords, private/channel keys,
// bearer/session tokens).
const SENSITIVE_KEY_PATTERN = /jwt|token|password|secret|private.?key|bearer|authorization|api.?key|channel.?key|session/i;

const MAX_REDACT_DEPTH = 6;

function redact(value, depth = 0) {
  if (depth >= MAX_REDACT_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }

  // Date (and similarly, anything with meaningful state that isn't exposed
  // as enumerable own properties) must be returned as-is rather than walked
  // with Object.entries(), which sees none of a Date's internal state and
  // would otherwise silently collapse it to "{}" once JSON.stringify'd.
  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(val, depth + 1);
  }
  return result;
}

/**
 * Creates a structured JSON logger. Every log line carries a stable logical
 * `source` (e.g. "services.radio.serial") and has known-sensitive fields in
 * its metadata automatically redacted before being written.
 *
 * @param {{level?: 'debug'|'info'|'warn'|'error'}} [options]
 */
export function createLogger({ level = 'info' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(logLevel, source, message, meta, reqInfo) {
    // Required HTTP/application pairs must survive an operator's log-level
    // filter. Standalone events and optional request debug details retain it.
    const requiredRequestRecord = reqInfo && logLevel !== 'debug';
    if (!requiredRequestRecord && LEVELS[logLevel] < threshold) {
      return;
    }

    const line = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      source,
      message,
      ...(reqInfo ? { reqInfo } : {}),
      ...(meta && Object.keys(meta).length > 0 ? { meta: redact(meta) } : {})
    };

    const output = JSON.stringify(line);
    if (logLevel === 'error' || logLevel === 'warn') {
      console.error(output);
    } else {
      console.log(output);
    }
  }

  function methods(reqInfo) {
    return {
      debug: (source, message, meta) => write('debug', source, message, meta, reqInfo),
      info: (source, message, meta) => write('info', source, message, meta, reqInfo),
      warn: (source, message, meta) => write('warn', source, message, meta, reqInfo),
      error: (source, message, meta) => write('error', source, message, meta, reqInfo)
    };
  }

  return {
    ...methods(),
    /** Bind generated, secret-free request metadata once at the HTTP boundary. */
    forRequest(reqInfo) {
      if (!validateRequestInfo(reqInfo)) {
        throw new TypeError('Invalid HTTP request log context');
      }
      const context = Object.freeze({ ...reqInfo });
      return {
        ...methods(context),
        http: (source) => write('http', source, 'HTTP request received', undefined, context)
      };
    }
  };
}
