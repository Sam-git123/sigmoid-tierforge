import { ApiError } from '../errors/api-error.js';
import type { ScoringRepository } from '../repositories/scoring-repository.js';
import { scoringConfigurationSchema } from '../schemas/scoring-schema.js';

function validationError(issues: { path: PropertyKey[]; message: string }[]) {
  return new ApiError(
    422,
    'SCORING_VALIDATION_ERROR',
    'Scoring configuration is invalid.',
    issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  );
}

export function createScoringService(repository: ScoringRepository) {
  return {
    async scoreJob(jobId: string, input: unknown) {
      const parsed = scoringConfigurationSchema.safeParse(input);
      if (!parsed.success) throw validationError(parsed.error.issues);
      const result = await repository.recalculate(jobId, parsed.data);
      if (result.outcome === 'not_found') {
        throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
      }
      if (result.outcome === 'not_terminal') {
        throw new ApiError(
          409,
          'JOB_NOT_TERMINAL',
          'Scoring is available only after enrichment reaches a terminal state.',
          { status: result.status },
        );
      }
      return result.summary;
    },

    async getCurrent(jobId: string) {
      const result = await repository.getCurrent(jobId);
      if (result.outcome === 'not_found') {
        throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
      }
      const { outcome: _outcome, ...current } = result;
      return current;
    },
  };
}

export type ScoringService = ReturnType<typeof createScoringService>;
