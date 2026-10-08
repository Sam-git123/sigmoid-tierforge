import { defineConfig } from 'vitest/config';
import { loadEnvironmentFile } from './src/config/load-env.js';

loadEnvironmentFile();
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
