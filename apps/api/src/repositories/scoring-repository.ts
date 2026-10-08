import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { ScoringConfiguration, ScoringSummary, TierCounts } from '../domain/scoring.js';

export type RecalculateScoringResult =
  | { outcome: 'not_found' }
  | { outcome: 'not_terminal'; status: string }
  | { outcome: 'scored'; summary: ScoringSummary };

export type CurrentScoringResult =
  | { outcome: 'not_found' }
  | {
      outcome: 'found';
      jobId: string;
      revision: number | null;
      configuration: ScoringConfiguration | null;
      storesScored: number;
      tierCounts: TierCounts;
    };

export interface ScoringRepository {
  recalculate(
    jobId: string,
    configuration: ScoringConfiguration,
  ): Promise<RecalculateScoringResult>;
  getCurrent(jobId: string): Promise<CurrentScoringResult>;
}

interface ScoringCountRow {
  storesScored: number;
  large: number;
  medium: number;
  small: number;
}

interface CurrentRow extends ScoringCountRow {
  jobId: string;
  revision: number | null;
  footfallBar: string | null;
  revenueBar: string | null;
  sizeBar: string | null;
  footfallWeight: string | null;
  revenueWeight: string | null;
  sizeWeight: string | null;
  largeThreshold: string | null;
  mediumThreshold: string | null;
}

function tierCounts(row: ScoringCountRow): TierCounts {
  return { large: row.large, medium: row.medium, small: row.small };
}

function configurationFromRow(row: CurrentRow): ScoringConfiguration | null {
  if (row.revision === null) return null;
  return {
    footfallBar: row.footfallBar!,
    revenueBar: row.revenueBar!,
    sizeBar: row.sizeBar!,
    footfallWeight: row.footfallWeight!,
    revenueWeight: row.revenueWeight!,
    sizeWeight: row.sizeWeight!,
    largeThreshold: row.largeThreshold!,
    mediumThreshold: row.mediumThreshold!,
  };
}

export function createScoringRepository(pool: Pool): ScoringRepository {
  return {
    async recalculate(jobId, configuration) {
      return withTransaction(pool, async (client) => {
        const job = await client.query<{ status: string }>(
          'SELECT status FROM jobs WHERE id = $1 FOR UPDATE',
          [jobId],
        );
        const status = job.rows[0]?.status;
        if (!status) return { outcome: 'not_found' };
        if (!['completed', 'completed_with_errors', 'failed'].includes(status)) {
          return { outcome: 'not_terminal', status };
        }
        const revisionResult = await client.query<{ revision: number }>(
          `SELECT (COALESCE(max(revision), 0) + 1)::integer AS revision
           FROM scoring_configs WHERE job_id = $1`,
          [jobId],
        );
        const revision = revisionResult.rows[0]!.revision;
        await client.query(
          `INSERT INTO scoring_configs
             (job_id, footfall_bar, revenue_bar, size_bar, footfall_weight, revenue_weight,
              size_weight, large_threshold, medium_threshold, revision)
           VALUES ($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric, $6::numeric,
             $7::numeric, $8::numeric, $9::numeric, $10)`,
          [
            jobId,
            configuration.footfallBar,
            configuration.revenueBar,
            configuration.sizeBar,
            configuration.footfallWeight,
            configuration.revenueWeight,
            configuration.sizeWeight,
            configuration.largeThreshold,
            configuration.mediumThreshold,
            revision,
          ],
        );
        const scored = await client.query<ScoringCountRow>(
          `WITH calculated AS (
             SELECT e.job_id, e.store_id,
               ((CASE WHEN e.estimated_monthly_footfall >= $3::numeric THEN $6::numeric ELSE 0 END) +
                (CASE WHEN e.estimated_monthly_revenue >= $4::numeric THEN $7::numeric ELSE 0 END) +
                (CASE WHEN e.store_size_sqft >= $5::numeric THEN $8::numeric ELSE 0 END))::numeric(5,2) AS score
             FROM store_enrichments e
             JOIN job_stores s ON s.job_id = e.job_id AND s.store_id = e.store_id
             WHERE e.job_id = $1 AND s.status = 'succeeded'
           ), upserted AS (
             INSERT INTO store_scores (job_id, store_id, score, tier, config_revision, computed_at)
             SELECT job_id, store_id, score,
               CASE WHEN score >= $9::numeric THEN 'Large'
                    WHEN score >= $10::numeric THEN 'Medium'
                    ELSE 'Small' END,
               $2, clock_timestamp()
             FROM calculated
             ON CONFLICT (job_id, store_id, config_revision) DO UPDATE SET
               score = EXCLUDED.score, tier = EXCLUDED.tier, computed_at = EXCLUDED.computed_at
             RETURNING tier
           )
           SELECT count(*)::integer AS "storesScored",
             (count(*) FILTER (WHERE tier = 'Large'))::integer AS large,
             (count(*) FILTER (WHERE tier = 'Medium'))::integer AS medium,
             (count(*) FILTER (WHERE tier = 'Small'))::integer AS small
           FROM upserted`,
          [
            jobId,
            revision,
            configuration.footfallBar,
            configuration.revenueBar,
            configuration.sizeBar,
            configuration.footfallWeight,
            configuration.revenueWeight,
            configuration.sizeWeight,
            configuration.largeThreshold,
            configuration.mediumThreshold,
          ],
        );
        const counts = scored.rows[0]!;
        return {
          outcome: 'scored',
          summary: {
            jobId,
            revision,
            configuration,
            storesScored: counts.storesScored,
            tierCounts: tierCounts(counts),
          },
        };
      });
    },

    async getCurrent(jobId) {
      const result = await pool.query<CurrentRow>(
        `WITH current_config AS (
           SELECT * FROM scoring_configs WHERE job_id = $1 ORDER BY revision DESC LIMIT 1
         ), score_counts AS (
           SELECT count(*)::integer AS "storesScored",
             (count(*) FILTER (WHERE s.tier = 'Large'))::integer AS large,
             (count(*) FILTER (WHERE s.tier = 'Medium'))::integer AS medium,
             (count(*) FILTER (WHERE s.tier = 'Small'))::integer AS small
           FROM store_scores s JOIN current_config c
             ON c.job_id = s.job_id AND c.revision = s.config_revision
         )
         SELECT j.id AS "jobId", c.revision,
           c.footfall_bar AS "footfallBar", c.revenue_bar AS "revenueBar",
           c.size_bar AS "sizeBar", c.footfall_weight AS "footfallWeight",
           c.revenue_weight AS "revenueWeight", c.size_weight AS "sizeWeight",
           c.large_threshold AS "largeThreshold", c.medium_threshold AS "mediumThreshold",
           COALESCE(sc."storesScored", 0)::integer AS "storesScored",
           COALESCE(sc.large, 0)::integer AS large,
           COALESCE(sc.medium, 0)::integer AS medium,
           COALESCE(sc.small, 0)::integer AS small
         FROM jobs j LEFT JOIN current_config c ON c.job_id = j.id
         CROSS JOIN score_counts sc WHERE j.id = $1`,
        [jobId],
      );
      const row = result.rows[0];
      if (!row) return { outcome: 'not_found' };
      return {
        outcome: 'found',
        jobId,
        revision: row.revision,
        configuration: configurationFromRow(row),
        storesScored: row.storesScored,
        tierCounts: tierCounts(row),
      };
    },
  };
}
