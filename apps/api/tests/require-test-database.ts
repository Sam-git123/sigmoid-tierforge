import { loadEnvironmentFile } from '../src/config/load-env.js';
loadEnvironmentFile();
if (!process.env.TEST_DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to run PostgreSQL integration tests. See README.md.');
  process.exitCode = 1;
}
