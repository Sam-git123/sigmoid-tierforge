import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { queryKeys } from '../api/query-keys';
import { tierForgeApi } from '../api/tierforge';
import { PageHeading } from '../components/app-shell';
import { FileUpload } from '../components/file-upload';
import { errorMessage } from '../utils/format';
import { isTerminalStatus } from '../utils/job';

export function UploadPage() {
  const navigate = useNavigate();
  const jobs = useQuery({
    queryKey: queryKeys.jobs,
    queryFn: tierForgeApi.getJobs,
    refetchInterval: (query) =>
      query.state.data?.records.some((job) => !isTerminalStatus(job.status)) ? 2_000 : false,
  });
  const upload = useMutation({
    mutationFn: tierForgeApi.uploadStores,
    onSuccess: (job) => {
      void jobs.refetch();
      navigate(`/jobs/${job.jobId}/progress`, { state: { warnings: job.warnings } });
    },
  });

  return (
    <>
      <PageHeading
        eyebrow="Step 1 of 4"
        title="Upload your store portfolio"
        description="Create an enrichment job from a CSV. TierForge validates every row before accepting the file, then processes jobs concurrently within shared resource limits."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <FileUpload
          isUploading={upload.isPending}
          serverError={upload.error ? errorMessage(upload.error) : undefined}
          onUpload={async (file) => {
            await upload.mutateAsync(file);
          }}
        />
        <aside className="rounded-2xl bg-slate-950 p-6 text-white shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-400">
            What happens next
          </p>
          <ol className="mt-5 space-y-5 text-sm">
            <li className="flex gap-3">
              <span className="font-bold text-cyan-400">01</span>
              <span>
                <strong className="block">Validate</strong>
                <span className="text-slate-400">
                  Headers, row shape, required values, and duplicate IDs are checked.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="font-bold text-cyan-400">02</span>
              <span>
                <strong className="block">Enrich</strong>
                <span className="text-slate-400">
                  Stores are processed safely against the rate-limited external service.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="font-bold text-cyan-400">03</span>
              <span>
                <strong className="block">Score</strong>
                <span className="text-slate-400">
                  Choose metric weights and thresholds after enrichment finishes.
                </span>
              </span>
            </li>
          </ol>
        </aside>
      </div>
      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Recent jobs</h2>
            <p className="mt-1 text-sm text-slate-500">
              Open any job independently while other uploads continue processing.
            </p>
          </div>
          <span className="text-sm text-slate-500">{jobs.data?.totalRecords ?? 0} total</span>
        </div>
        {jobs.isPending ? (
          <p className="mt-5 text-sm text-slate-500">Loading recent jobs…</p>
        ) : jobs.error ? (
          <p className="mt-5 text-sm text-rose-700">{errorMessage(jobs.error)}</p>
        ) : jobs.data?.records.length ? (
          <ul className="mt-5 divide-y divide-slate-100">
            {jobs.data.records.map((job) => (
              <li
                key={job.jobId}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <p className="font-mono text-sm text-slate-800">{job.jobId}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {job.totalStores.toLocaleString()} stores · {job.status.replaceAll('_', ' ')}
                  </p>
                </div>
                <Link
                  to={`/jobs/${job.jobId}/progress`}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:border-cyan-500 hover:text-cyan-800"
                >
                  View job
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-5 text-sm text-slate-500">No jobs have been created yet.</p>
        )}
      </section>
    </>
  );
}
