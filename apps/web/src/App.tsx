import { Link, Outlet, Route, Routes } from 'react-router';

function AppShell() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-5">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            TierForge
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-16">
        <Outlet />
      </main>
    </div>
  );
}

function HomePage() {
  return (
    <section aria-labelledby="page-title">
      <p className="mb-3 text-sm font-medium text-slate-500">Store scoring &amp; tiering</p>
      <h1 id="page-title" className="text-4xl font-semibold tracking-tight">
        TierForge
      </h1>
      <p className="mt-4 max-w-lg text-base leading-7 text-slate-600">
        A workspace for understanding your stores. More tools are on the way.
      </p>
    </section>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route
          path="*"
          element={
            <p>
              Page not found.{' '}
              <Link to="/" className="underline">
                Go home
              </Link>
              .
            </p>
          }
        />
      </Route>
    </Routes>
  );
}
