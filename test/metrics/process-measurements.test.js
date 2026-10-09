import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ProcessMeasurements } from '../../src/metrics/process-measurements.js';

function fixture() {
  let at = 0; let cpu = { user: 0, system: 0 };
  let memory = { rss: 100, heapTotal: 80, heapUsed: 60, external: 20, arrayBuffers: 10 };
  let loop = { active: 0, idle: 0, utilization: 0 };
  const collector = new ProcessMeasurements({ monotonicNow: () => at,
    cpuUsage: () => { if (cpu instanceof Error) throw cpu; return cpu; },
    memoryUsage: () => { if (memory instanceof Error) throw memory; return memory; },
    eventLoopUsage: () => { if (loop instanceof Error) throw loop; return loop; } });
  return { collector, set: (values) => {
    if ('at' in values) at = values.at; if ('cpu' in values) cpu = values.cpu;
    if ('memory' in values) memory = values.memory; if ('loop' in values) loop = values.loop;
  } };
}

test('first observation has byte memory and unavailable interval CPU/ELU rather than zero', () => {
  const { collector } = fixture(); const { measurements, unavailable } = collector.collect();
  assert.equal(measurements.intervalMs, null); assert.equal(measurements.cpuPercent, null);
  assert.equal(measurements.eventLoopUtilization, null); assert.equal(measurements.rssBytes, 100);
  assert.equal(measurements.heapTotalBytes, 80); assert.equal(measurements.heapUsedBytes, 60);
  assert.equal(measurements.externalBytes, 20); assert.deepEqual(unavailable, []);
});
test('one-CPU normalization uses actual elapsed time and allows 25%, 200% and real zero', () => {
  const { collector, set } = fixture(); collector.collect();
  set({ at: 1000, cpu: { user: 200000, system: 50000 }, loop: { active: 250, idle: 750, utilization: 0.25 } });
  let sample = collector.collect().measurements;
  assert.equal(sample.cpuPercent, 25); assert.equal(sample.cpuUserUs, 200000);
  assert.equal(sample.cpuSystemUs, 50000); assert.equal(sample.eventLoopUtilization, 0.25);
  set({ at: 3000, cpu: { user: 4200000, system: 50000 }, loop: { active: 2250, idle: 750, utilization: 0.75 } });
  sample = collector.collect().measurements;
  assert.equal(sample.intervalMs, 2000); assert.equal(sample.cpuPercent, 200);
  assert.equal(sample.eventLoopUtilization, 1);
  set({ at: 4000 }); sample = collector.collect().measurements;
  assert.equal(sample.cpuPercent, 0); assert.equal(sample.eventLoopUtilization, null);
});
test('zero/negative elapsed and counter reset discard their interval and rebaseline', () => {
  const { collector, set } = fixture(); collector.collect();
  set({ cpu: { user: 100, system: 0 } }); assert.equal(collector.collect().measurements.cpuPercent, null);
  set({ at: 1000, cpu: { user: 50, system: 0 } }); assert.equal(collector.collect().measurements.cpuPercent, null);
  set({ at: 900, cpu: { user: 60, system: 0 } });
  assert.equal(collector.collect().measurements.intervalMs, null);
  set({ at: 1900, cpu: { user: 100060, system: 0 } }); assert.equal(collector.collect().measurements.cpuPercent, 10);
});
test('optional native failures are isolated by measurement family and recover without invented deltas', () => {
  const { collector, set } = fixture(); collector.collect();
  set({ at: 1000, cpu: new Error('unavailable'), memory: new Error('unavailable'), loop: new Error('unavailable') });
  let result = collector.collect(); assert.deepEqual(result.unavailable, ['cpu', 'memory', 'event-loop']);
  assert.equal(result.measurements.cpuPercent, null); assert.equal(result.measurements.rssBytes, null);
  set({ at: 2000, cpu: { user: 100, system: 0 }, memory: { rss: 1, heapTotal: 1, heapUsed: 1, external: 0 },
    loop: { active: 10, idle: 90, utilization: 0.1 } });
  result = collector.collect(); assert.equal(result.measurements.cpuPercent, null); assert.equal(result.measurements.rssBytes, 1);
  set({ at: 3000, cpu: { user: 250100, system: 0 }, loop: { active: 110, idle: 990, utilization: 0.1 } });
  result = collector.collect(); assert.equal(result.measurements.cpuPercent, 25); assert.equal(result.measurements.eventLoopUtilization, 0.1);
});
test('strict native reading validation rejects extras, negative values, NaN and invalid clock before arithmetic', () => {
  const { collector, set } = fixture(); collector.collect();
  set({ at: NaN, cpu: { user: 0, system: 0, extra: true }, memory: { rss: -1, heapTotal: 1, heapUsed: 1, external: 0 },
    loop: { active: NaN, idle: 0, utilization: 0 } });
  const result = collector.collect(); assert.deepEqual(result.unavailable, ['clock', 'cpu', 'memory', 'event-loop']);
  assert.ok(Object.values(result.measurements).every((value) => value === null));
});
test('event-loop counter reset does not erase valid CPU or memory; a later valid interval recovers', () => {
  const { collector, set } = fixture();
  set({ loop: { active: 50, idle: 50, utilization: 0.5 } }); collector.collect();
  set({ at: 1000, cpu: { user: 250000, system: 0 }, loop: { active: 10, idle: 10, utilization: 0.5 } });
  let sample = collector.collect().measurements; assert.equal(sample.cpuPercent, 25); assert.equal(sample.eventLoopUtilization, null);
  set({ at: 2000, loop: { active: 110, idle: 910, utilization: 110 / 1020 } });
  sample = collector.collect().measurements; assert.equal(sample.eventLoopUtilization, 0.1);
});
