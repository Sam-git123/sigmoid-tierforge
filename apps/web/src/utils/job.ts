import type { JobProgress } from '../api/tierforge';

export function isTerminalStatus(status: JobProgress['status']): boolean {
  return ['completed', 'completed_with_errors', 'failed'].includes(status);
}
