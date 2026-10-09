import { performance } from 'node:perf_hooks';
import { compileSchema } from '../validation/ajv.js';
import { cpuReadingSchema, memoryReadingSchema, eventLoopReadingSchema, monotonicReadingSchema, processMeasurementSchema } from './process-schemas.js';

const validateCpu = compileSchema(cpuReadingSchema);
const validateMemory = compileSchema(memoryReadingSchema);
const validateLoop = compileSchema(eventLoopReadingSchema);
const validateTime = compileSchema(monotonicReadingSchema);
const validateMeasurement = compileSchema(processMeasurementSchema);

/** Built-in counters only; no histogram, timer, network, or host-capacity guess. */
export class ProcessMeasurements {
  #cpu; #memory; #loop; #now;
  #previousAt = null; #previousCpu = null; #previousLoop = null;

  constructor({ cpuUsage = () => process.cpuUsage(), memoryUsage = () => process.memoryUsage(),
    eventLoopUsage = () => performance.eventLoopUtilization(), monotonicNow = () => performance.now() } = {}) {
    this.#cpu = cpuUsage; this.#memory = memoryUsage; this.#loop = eventLoopUsage; this.#now = monotonicNow;
  }

  collect() {
    const unavailable = [];
    const read = (name, get, validate) => {
      try { const value = get(); if (validate(value)) return value; } catch { /* Optional native measurement. */ }
      unavailable.push(name); return null;
    };
    const at = read('clock', this.#now, validateTime);
    const cpu = read('cpu', this.#cpu, validateCpu);
    const memory = read('memory', this.#memory, validateMemory);
    const loop = read('event-loop', this.#loop, validateLoop);
    const elapsed = at !== null && this.#previousAt !== null ? at - this.#previousAt : null;
    const intervalMs = elapsed > 0 ? elapsed : null;
    const measurements = {
      intervalMs, cpuUserUs: null, cpuSystemUs: null, cpuPercent: null,
      rssBytes: memory?.rss ?? null, heapTotalBytes: memory?.heapTotal ?? null,
      heapUsedBytes: memory?.heapUsed ?? null, externalBytes: memory?.external ?? null,
      eventLoopActiveMs: null, eventLoopIdleMs: null, eventLoopUtilization: null
    };
    if (intervalMs !== null && cpu && this.#previousCpu) {
      const user = cpu.user - this.#previousCpu.user; const system = cpu.system - this.#previousCpu.system;
      if (user >= 0 && system >= 0) {
        measurements.cpuUserUs = user; measurements.cpuSystemUs = system;
        measurements.cpuPercent = 100 * (user + system) / (intervalMs * 1000);
      }
    }
    if (intervalMs !== null && loop && this.#previousLoop) {
      const active = loop.active - this.#previousLoop.active; const idle = loop.idle - this.#previousLoop.idle;
      if (active >= 0 && idle >= 0 && active + idle > 0) {
        measurements.eventLoopActiveMs = active; measurements.eventLoopIdleMs = idle;
        measurements.eventLoopUtilization = active / (active + idle);
      }
    }
    this.#previousAt = at;
    this.#previousCpu = at === null ? null : cpu;
    this.#previousLoop = at === null ? null : loop;
    if (!validateMeasurement(measurements)) throw new Error('Invalid derived process measurements');
    return { measurements, unavailable };
  }
}
