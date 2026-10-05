import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      reportsDirectory: './coverage-test',
      provider: 'v8',
      include: ['packages/**/src/**/*.{js,ts}'],
      reporter: ['text', 'html', 'clover', 'json', 'lcov']
    }
  }
});
