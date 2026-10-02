import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
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
        statements: 100,
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
