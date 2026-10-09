import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';
import { createTierForgeApi, type JobProgress } from '../src/api/tierforge';
import { DashboardStats, StoreResultsTable } from '../src/components/dashboard';
import { FailureTable } from '../src/components/failure-table';
import { JobProgressPanel } from '../src/components/job-progress';
import { ScoringForm } from '../src/components/scoring-form';
import { validateCsvHeaderText } from '../src/utils/csv';
import { defaultScoringInput, validateScoringInput } from '../src/utils/scoring';

const job: JobProgress = {
  jobId: '00000000-0000-4000-8000-000000000001',
  status: 'running',
  totalStores: 10,
  createdAt: '2026-10-08T10:00:00.000Z',
  startedAt: '2026-10-08T10:00:01.000Z',
  finishedAt: null,
  failureCode: null,
  failureReason: null,
  counts: { pending: 3, processing: 1, retryWait: 1, succeeded: 4, failed: 1, skipped: 0 },
  completedStores: 5,
  unfinishedStores: 5,
  progressPercentage: 50,
};

describe('Phase 8 workflow', () => {
  it('reports missing and duplicate CSV headers clearly', () => {
    expect(validateCsvHeaderText('store_id,store_id,address,city,state,country\n')).toEqual([
      'Duplicate column: store_id.',
      'Missing required column: store_name.',
    ]);
    expect(validateCsvHeaderText('store_id,store_name,address,city,state,country\n')).toEqual([]);
  });

  it('rejects invalid scoring weight totals and disables submission', () => {
    const invalid = { ...defaultScoringInput, sizeWeight: '19.99' };
    expect(validateScoringInput(invalid)).toMatchObject({ valid: false, weightTotal: 99.99 });
    const html = renderToStaticMarkup(
      <ScoringForm
        initialValues={invalid}
        isSubmitting={false}
        revision={null}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('The three weights must total exactly 100%.');
    expect(html).toContain('disabled=""');
  });

  it('renders real progress counts and terminal failure details', () => {
    const running = renderToStaticMarkup(<JobProgressPanel job={job} />);
    expect(running).toContain('50.0%');
    expect(running).toContain('Successfully enriched');
    expect(running).toContain('Waiting for retry');

    const failed = renderToStaticMarkup(
      <JobProgressPanel
        job={{
          ...job,
          status: 'failed',
          failureCode: 'UPSTREAM_UNAVAILABLE',
          failureReason: 'The enrichment provider remained unavailable.',
          finishedAt: '2026-10-08T10:10:00.000Z',
        }}
      />,
    );
    expect(failed).toContain('UPSTREAM_UNAVAILABLE');
    expect(failed).toContain('The enrichment provider remained unavailable.');
  });

  it('renders dashboard loading and filtered empty states', () => {
    const common = {
      pageSize: 50,
      onTierChange: vi.fn(),
      onPageChange: vi.fn(),
      onPageSizeChange: vi.fn(),
    };
    expect(renderToStaticMarkup(<StoreResultsTable {...common} loading />)).toContain(
      'Loading store results',
    );
    expect(
      renderToStaticMarkup(
        <StoreResultsTable
          {...common}
          loading={false}
          tier="Large"
          data={{ records: [], page: 1, pageSize: 50, totalRecords: 0, totalPages: 0 }}
        />,
      ),
    ).toContain('No stores are currently scored as Large.');
  });

  it('renders dashboard pending counts and persisted failure reasons', () => {
    const summary = renderToStaticMarkup(
      <DashboardStats
        dashboard={{
          job: {
            ...job,
            counts: job.counts,
          },
          successfullyEnrichedStores: 4,
          failedStores: 1,
          skippedStores: 0,
          scoredStores: 4,
          tierCounts: { large: 1, medium: 2, small: 1 },
          currentScoringRevision: 1,
          currentScoringConfiguration: null,
        }}
      />,
    );
    expect(summary).toContain('Pending');
    expect(summary).toContain('Pending, processing, or retrying');
    expect(summary).toContain('>5<');

    const failures = renderToStaticMarkup(
      <FailureTable
        loading={false}
        data={{
          records: [
            {
              storeId: 'FAILED-1',
              storeName: 'Failed store',
              attemptCount: 5,
              lastErrorCode: 'RETRY_EXHAUSTED',
              lastErrorMessage: 'Provider failed after five attempts.',
              finalStatus: 'failed',
            },
          ],
          page: 1,
          pageSize: 20,
          totalRecords: 1,
          totalPages: 1,
        }}
        onPageChange={vi.fn()}
      />,
    );
    expect(failures).toContain('RETRY_EXHAUSTED');
    expect(failures).toContain('Provider failed after five attempts.');
  });
});

describe('typed API integration', () => {
  it('sends the exact scoring form payload as JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          jobId: job.jobId,
          revision: 1,
          configuration: {
            footfallBar: '15000.00',
            revenueBar: '150000.00',
            sizeBar: '8000.00',
            footfallWeight: '50.00',
            revenueWeight: '30.00',
            sizeWeight: '20.00',
            largeThreshold: '70.00',
            mediumThreshold: '40.00',
          },
          storesScored: 10,
          tierCounts: { large: 3, medium: 4, small: 3 },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await createTierForgeApi(createApiClient('/api', fetcher)).scoreJob(
      job.jobId,
      defaultScoringInput,
    );
    const options = fetcher.mock.calls[0]?.[1];
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/jobs/${job.jobId}/scoring`);
    expect(JSON.parse(String(options?.body))).toEqual(defaultScoringInput);
  });

  it('applies tier filtering and pagination to the backend request', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ records: [], page: 2, pageSize: 25, totalRecords: 0, totalPages: 0 }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
    await createTierForgeApi(createApiClient('/api', fetcher)).getStores(job.jobId, {
      page: 2,
      pageSize: 25,
      tier: 'Medium',
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/api/jobs/${job.jobId}/stores?page=2&pageSize=25&tier=Medium`,
    );
  });
});
