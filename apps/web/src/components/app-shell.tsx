import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router';

const steps = [
  { number: 1, label: 'Upload Stores', path: '' },
  { number: 2, label: 'Enrichment', path: 'progress' },
  { number: 3, label: 'Configure Scoring', path: 'scoring' },
  { number: 4, label: 'Dashboard', path: 'dashboard' },
] as const;

function BrandMark() {
  return (
    <span className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-400 text-sm font-black text-slate-950 shadow-sm shadow-cyan-500/30">
      TF
    </span>
  );
}

export function AppShell() {
  const { jobId } = useParams();
  const location = useLocation();
  const activeStep = location.pathname.includes('/progress')
    ? 2
    : location.pathname.includes('/scoring')
      ? 3
      : location.pathname.includes('/dashboard')
        ? 4
        : 1;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-800 bg-slate-950 text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-3" aria-label="TierForge home">
            <BrandMark />
            <span>
              <span className="block text-lg font-semibold leading-5 tracking-tight">
                TierForge
              </span>
              <span className="text-xs text-slate-400">Store intelligence workspace</span>
            </span>
          </Link>
          <span className="hidden rounded-full border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300 sm:block">
            Enrich · Score · Segment
          </span>
        </div>
      </header>

      <div className="border-b border-slate-200 bg-white">
        <nav
          aria-label="TierForge workflow"
          className="mx-auto max-w-7xl overflow-x-auto px-4 sm:px-6 lg:px-8"
        >
          <ol className="flex min-w-[680px] items-center py-4">
            {steps.map((step, index) => {
              const enabled = step.number === 1 || Boolean(jobId);
              const destination = step.number === 1 ? '/' : `/jobs/${jobId}/${step.path}`;
              const content = (
                <>
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ${
                      activeStep === step.number
                        ? 'bg-cyan-500 text-slate-950'
                        : activeStep > step.number
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {activeStep > step.number ? '✓' : step.number}
                  </span>
                  <span
                    className={
                      activeStep === step.number ? 'font-semibold text-slate-950' : 'text-slate-500'
                    }
                  >
                    {step.label}
                  </span>
                </>
              );
              return (
                <li key={step.number} className="flex flex-1 items-center">
                  {enabled ? (
                    <NavLink to={destination} className="flex items-center gap-2 text-sm">
                      {content}
                    </NavLink>
                  ) : (
                    <span
                      className="flex cursor-not-allowed items-center gap-2 text-sm"
                      aria-disabled="true"
                    >
                      {content}
                    </span>
                  )}
                  {index < steps.length - 1 && (
                    <span className="mx-4 h-px flex-1 bg-slate-200" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </div>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-cyan-700">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
    >
      <span className="font-semibold">Unable to complete the request.</span> {message}
    </div>
  );
}

export function LoadingPanel({ label = 'Loading data…' }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex min-h-48 items-center justify-center rounded-2xl border border-slate-200 bg-white"
    >
      <span className="mr-3 h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-cyan-600" />
      <span className="text-sm font-medium text-slate-600">{label}</span>
    </div>
  );
}
