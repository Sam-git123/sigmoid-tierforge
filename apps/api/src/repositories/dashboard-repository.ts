import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type {
  DashboardSummary,
  FailureReadModel,
  Paginated,
  Pagination,
  StoreListOptions,
  StoreReadModel,
} from '../domain/dashboard.js';
import type { JobCounts, JobStatus } from '../domain/jobs.js';
import type { ScoringConfiguration } from '../domain/scoring.js';

export interface DashboardRepository {
  listStores(jobId: string, options: StoreListOptions): Promise<Paginated<StoreReadModel> | null>;
  listFailures(jobId: string, options: Pagination): Promise<Paginated<FailureReadModel> | null>;
  getDashboard(jobId: string): Promise<DashboardSummary | null>;
}

interface CountRow {
  totalRecords: number;
}

interface DashboardRow extends JobCounts {
  jobId: string;
  status: JobStatus;
  totalStores: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  failureCode: string | null;
  failureReason: string | null;
  revision: number | null;
  footfallBar: string | null;
  revenueBar: string | null;
  sizeBar: string | null;
  footfallWeight: string | null;
  revenueWeight: string | null;
  sizeWeight: string | null;
  largeThreshold: string | null;
  mediumThreshold: string | null;
  scoredStores: number;
  large: number;
  medium: number;
  small: number;
}

function paginated<T>(records: T[], options: Pagination, totalRecords: number): Paginated<T> {
  return {
    records,
    page: options.page,
    pageSize: options.pageSize,
    totalRecords,
    totalPages: totalRecords === 0 ? 0 : Math.ceil(totalRecords / options.pageSize),
  };
}

async function jobExists(client: PoolClient, jobId: string): Promise<boolean> {
  return (await client.query('SELECT 1 FROM jobs WHERE id = $1', [jobId])).rowCount === 1;
}

function currentConfiguration(row: DashboardRow): ScoringConfiguration | null {
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

export function createDashboardRepository(pool: Pool): DashboardRepository {
  return {
    async listStores(jobId, options) {
      return withTransaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        if (!(await jobExists(client, jobId))) return null;
        const countTierClause = options.tier ? 'AND scores.tier = $2' : '';
        const recordsTierClause = options.tier ? 'AND scores.tier = $4' : '';
        const countParameters = options.tier ? [jobId, options.tier] : [jobId];
        const recordParameters = options.tier
          ? [jobId, options.pageSize, (options.page - 1) * options.pageSize, options.tier]
          : [jobId, options.pageSize, (options.page - 1) * options.pageSize];
        const count = await client.query<CountRow>(
          `WITH current_config AS (
             SELECT revision FROM scoring_configs
             WHERE job_id = $1 ORDER BY revision DESC LIMIT 1
           )
           SELECT count(*)::integer AS "totalRecords"
           FROM job_stores stores
           LEFT JOIN current_config config ON true
           LEFT JOIN store_scores scores ON scores.job_id = stores.job_id
             AND scores.store_id = stores.store_id
             AND scores.config_revision = config.revision
           WHERE stores.job_id = $1 ${countTierClause}`,
          countParameters,
        );
        const records = await client.query<StoreReadModel>(
          `WITH current_config AS (
             SELECT revision FROM scoring_configs
             WHERE job_id = $1 ORDER BY revision DESC LIMIT 1
           )
           SELECT stores.store_id AS "storeId", stores.store_name AS "storeName",
             stores.address, stores.city, stores.state, stores.country, stores.status,
             enrichments.estimated_monthly_footfall AS "estimatedMonthlyFootfall",
             enrichments.estimated_monthly_revenue AS "estimatedMonthlyRevenue",
             enrichments.store_size_sqft AS "storeSizeSqft",
             scores.score, scores.tier,
             stores.last_error_code AS "lastErrorCode",
             stores.last_error_message AS "lastErrorMessage"
           FROM job_stores stores
           LEFT JOIN store_enrichments enrichments ON enrichments.job_id = stores.job_id
             AND enrichments.store_id = stores.store_id
           LEFT JOIN current_config config ON true
           LEFT JOIN store_scores scores ON scores.job_id = stores.job_id
             AND scores.store_id = stores.store_id
             AND scores.config_revision = config.revision
           WHERE stores.job_id = $1 ${recordsTierClause}
           ORDER BY stores.store_id
           LIMIT $2 OFFSET $3`,
          recordParameters,
        );
        return paginated(records.rows, options, count.rows[0]!.totalRecords);
      });
    },

    async listFailures(jobId, options) {
      return withTransaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        if (!(await jobExists(client, jobId))) return null;
        const count = await client.query<CountRow>(
          `SELECT count(*)::integer AS "totalRecords" FROM job_stores
           WHERE job_id = $1 AND status IN ('failed', 'skipped')`,
          [jobId],
        );
        const records = await client.query<FailureReadModel>(
          `SELECT store_id AS "storeId", store_name AS "storeName",
             attempt_count AS "attemptCount", last_error_code AS "lastErrorCode",
             last_error_message AS "lastErrorMessage", status AS "finalStatus"
           FROM job_stores
           WHERE job_id = $1 AND status IN ('failed', 'skipped')
           ORDER BY store_id LIMIT $2 OFFSET $3`,
          [jobId, options.pageSize, (options.page - 1) * options.pageSize],
        );
        return paginated(records.rows, options, count.rows[0]!.totalRecords);
      });
    },

    async getDashboard(jobId) {
      const result = await pool.query<DashboardRow>(
        `WITH store_counts AS (
           SELECT
             (count(*) FILTER (WHERE status = 'pending'))::integer AS pending,
             (count(*) FILTER (WHERE status = 'processing'))::integer AS processing,
             (count(*) FILTER (WHERE status = 'retry_wait'))::integer AS "retryWait",
             (count(*) FILTER (WHERE status = 'succeeded'))::integer AS succeeded,
             (count(*) FILTER (WHERE status = 'failed'))::integer AS failed,
             (count(*) FILTER (WHERE status = 'skipped'))::integer AS skipped
           FROM job_stores WHERE job_id = $1
         ), current_config AS (
           SELECT * FROM scoring_configs WHERE job_id = $1 ORDER BY revision DESC LIMIT 1
         ), score_counts AS (
           SELECT count(*)::integer AS "scoredStores",
             (count(*) FILTER (WHERE scores.tier = 'Large'))::integer AS large,
             (count(*) FILTER (WHERE scores.tier = 'Medium'))::integer AS medium,
             (count(*) FILTER (WHERE scores.tier = 'Small'))::integer AS small
           FROM store_scores scores JOIN current_config config
             ON config.job_id = scores.job_id AND config.revision = scores.config_revision
         )
         SELECT jobs.id AS "jobId", jobs.status, jobs.total_stores AS "totalStores",
           jobs.created_at AS "createdAt", jobs.started_at AS "startedAt",
           jobs.finished_at AS "finishedAt", jobs.failure_code AS "failureCode",
           jobs.failure_reason AS "failureReason",
           stores.pending, stores.processing, stores."retryWait", stores.succeeded,
           stores.failed, stores.skipped,
           config.revision, config.footfall_bar AS "footfallBar",
           config.revenue_bar AS "revenueBar", config.size_bar AS "sizeBar",
           config.footfall_weight AS "footfallWeight",
           config.revenue_weight AS "revenueWeight", config.size_weight AS "sizeWeight",
           config.large_threshold AS "largeThreshold",
           config.medium_threshold AS "mediumThreshold",
           scores."scoredStores", scores.large, scores.medium, scores.small
         FROM jobs CROSS JOIN store_counts stores CROSS JOIN score_counts scores
         LEFT JOIN current_config config ON true
         WHERE jobs.id = $1`,
        [jobId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const counts = {
        pending: row.pending,
        processing: row.processing,
        retryWait: row.retryWait,
        succeeded: row.succeeded,
        failed: row.failed,
        skipped: row.skipped,
      };
      return {
        job: {
          jobId: row.jobId,
          status: row.status,
          totalStores: row.totalStores,
          counts,
          createdAt: row.createdAt,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          failureCode: row.failureCode,
          failureReason: row.failureReason,
        },
        successfullyEnrichedStores: row.succeeded,
        failedStores: row.failed,
        skippedStores: row.skipped,
        scoredStores: row.scoredStores,
        tierCounts: { large: row.large, medium: row.medium, small: row.small },
        currentScoringRevision: row.revision,
        currentScoringConfiguration: currentConfiguration(row),
      };
    },
  };
}
