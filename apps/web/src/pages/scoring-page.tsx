import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { queryKeys } from '../api/query-keys';
import { tierForgeApi, type ScoringInput } from '../api/tierforge';
import { ErrorNotice, LoadingPanel, PageHeading } from '../components/app-shell';
import { ScoringForm } from '../components/scoring-form';
import { errorMessage } from '../utils/format';
import { isTerminalStatus } from '../utils/job';
import { defaultScoringInput } from '../utils/scoring';

export function ScoringPage() {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const job = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: () => tierForgeApi.getJob(jobId),
    enabled: Boolean(jobId),
  });
  const scoring = useQuery({
    queryKey: queryKeys.scoring(jobId),
    queryFn: () => tierForgeApi.getScoring(jobId),
    enabled: Boolean(jobId),
  });
  const mutation = useMutation({
    mutationFn: (configuration: ScoringInput) => tierForgeApi.scoreJob(jobId, configuration),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.scoring(jobId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(jobId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allStores(jobId) }),
      ]);
      navigate(`/jobs/${jobId}/dashboard`, { state: { recalculated: true } });
    },
  });
  const loading = job.isPending || scoring.isPending;
  const loadError = job.error ?? scoring.error;

  return (
    <>
      <PageHeading
        eyebrow="Step 3 of 4"
        title="Configure store scoring"
        description="Set the performance bars, distribute exactly 100% of weight, and define inclusive Large and Medium tier thresholds."
        action={
          <Link
            to={`/jobs/${jobId}/progress`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Back to progress
          </Link>
        }
      />
      {loading ? (
        <LoadingPanel label="Loading scoring configuration…" />
      ) : loadError ? (
        <ErrorNotice message={errorMessage(loadError)} />
      ) : job.data && scoring.data ? (
        !isTerminalStatus(job.data.status) ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
            <h2 className="font-semibold">Enrichment is still active</h2>
            <p className="mt-2 text-sm">
              Scoring becomes available when the job reaches a terminal state.
            </p>
            <Link
              to={`/jobs/${jobId}/progress`}
              className="mt-4 inline-flex font-semibold underline"
            >
              Return to progress
            </Link>
          </div>
        ) : job.data.counts.succeeded === 0 ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-900">
            <h2 className="font-semibold">No stores are available to score</h2>
            <p className="mt-2 text-sm">
              This job completed without a successful enrichment result.
            </p>
          </div>
        ) : (
          <ScoringForm
            key={scoring.data.revision ?? 'new'}
            initialValues={scoring.data.configuration ?? defaultScoringInput}
            revision={scoring.data.revision}
            isSubmitting={mutation.isPending}
            submitError={mutation.error ? errorMessage(mutation.error) : undefined}
            onSubmit={(values) => mutation.mutate(values)}
          />
        )
      ) : null}
    </>
  );
}
