import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ApiClientError } from '../api/client';
import { tierForgeApi } from '../api/tierforge';
import { PageHeading } from '../components/app-shell';
import { FileUpload } from '../components/file-upload';
import { errorMessage } from '../utils/format';

function activeJobId(error: unknown): string | null {
  if (
    !(error instanceof ApiClientError) ||
    typeof error.details !== 'object' ||
    error.details === null
  )
    return null;
  return 'activeJobId' in error.details && typeof error.details.activeJobId === 'string'
    ? error.details.activeJobId
    : null;
}

export function UploadPage() {
  const navigate = useNavigate();
  const upload = useMutation({
    mutationFn: tierForgeApi.uploadStores,
    onSuccess: (job) =>
      navigate(`/jobs/${job.jobId}/progress`, { state: { warnings: job.warnings } }),
  });
  const existingJobId = activeJobId(upload.error);

  return (
    <>
      <PageHeading
        eyebrow="Step 1 of 4"
        title="Upload your store portfolio"
        description="Create one enrichment job from a CSV. TierForge validates every row before accepting the file, then processes stores asynchronously."
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
          {existingJobId && (
            <Link
              to={`/jobs/${existingJobId}/progress`}
              className="mt-6 inline-flex rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-50"
            >
              View active job
            </Link>
          )}
        </aside>
      </div>
    </>
  );
}
