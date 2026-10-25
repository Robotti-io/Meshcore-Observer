import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    include: ['test/**/*.test.js'],
    // Cost gates assert wall-clock p95 targets. Run files one at a time so
    // other test workers do not add contention to their measurements.
    fileParallelism: false,
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
