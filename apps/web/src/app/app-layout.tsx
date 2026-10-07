import { Link, Outlet } from 'react-router';
import { UserMenu } from '../features/auth/user-menu';
import { ApiStatus } from '../features/status/api-status';

export function AppLayout() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/" className="font-semibold tracking-tight">
            SEO Keyword Tracker
          </Link>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <ApiStatus />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
