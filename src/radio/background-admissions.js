import { compileSchema } from '../validation/ajv.js';
import { remoteBackgroundDemandSchema } from './remote-coordinator-schemas.js';

const valid = compileSchema(remoteBackgroundDemandSchema);

/** Two expiring demand slots, never a queue or a physical-attempt budget. */
export function createBackgroundAdmissions({ now, lifetimeMs }) {
  const demand = new Map();
  let last = null;
  const prune = () => {
    const time = now();
    for (const [source, expires] of demand) if (expires <= time) demand.delete(source);
    return time;
  };
  return Object.freeze({
    note(input) {
      if (!valid(input)) throw new Error('Invalid background demand');
      demand.set(input.source, prune() + lifetimeMs);
    },
    allowed(source) {
      prune();
      return demand.size < 2 || last === null || last !== source;
    },
    sent(source) { last = source; demand.delete(source); },
    withdraw(source) { demand.delete(source); },
    clear() { demand.clear(); }
  });
}
