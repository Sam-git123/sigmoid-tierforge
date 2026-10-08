import { Link, Route, Routes } from 'react-router';
import { AppShell } from './components/app-shell';
import { DashboardPage } from './pages/dashboard-page';
import { ProgressPage } from './pages/progress-page';
import { ScoringPage } from './pages/scoring-page';
import { UploadPage } from './pages/upload-page';

function NotFoundPage() {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-6 py-16 text-center shadow-sm">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-700">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Page not found</h1>
      <p className="mt-3 text-slate-500">The TierForge page you requested does not exist.</p>
      <Link
        to="/"
        className="mt-6 inline-flex rounded-lg bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800"
      >
        Return to upload
      </Link>
    </section>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<UploadPage />} />
        <Route path="jobs/:jobId/progress" element={<ProgressPage />} />
        <Route path="jobs/:jobId/scoring" element={<ScoringPage />} />
        <Route path="jobs/:jobId/dashboard" element={<DashboardPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
