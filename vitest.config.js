import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // The *-cost tests assert wall-clock p95 targets while entrypoint tests
    // spawn child processes. Four workers match the hosted CI runner without
    // allowing the full suite to oversubscribe the machine.
    maxWorkers: 4,
    reporters: [
      'default',
      ['junit', { outputFile: 'artifacts/junit.xml' }]
    ],
    coverage: {
      provider: 'istanbul',
      all: true,
      include: ['src/**/*.js'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: {
        statements: 72,
        branches: 71,
        functions: 73,
        lines: 70
      },
      reporter: [
        'text-summary',
        'html',
        'lcov',
        'json',
        'cobertura'
      ]
    }
  }
});
