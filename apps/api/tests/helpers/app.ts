import { createApp } from '../../src/app.js';
import type { Logger } from 'pino';
import type { CheckDatabase } from '../../src/services/health-service.js';

export function createFoundationApp(options: { logger: Logger; checkDatabase: CheckDatabase }) {
  return createApp({
    ...options,
    csvMaxBytes: 10_485_760,
    jobService: {
      async createJob() {
        throw new Error('Unexpected job service call in a foundation test');
      },
      async getJob() {
        throw new Error('Unexpected job service call in a foundation test');
      },
    },
  });
}
