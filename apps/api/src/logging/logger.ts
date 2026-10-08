import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'tierforge-api' },
    redact: { paths: ['password', 'DATABASE_URL', 'authorization'], censor: '[REDACTED]' },
  });
}
