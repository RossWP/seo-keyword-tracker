import { Link, Outlet } from 'react-router';
import { UserMenu } from '../features/auth/user-menu';
import { ApiStatus } from '../features/status/api-status';

export function AppLayout() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="font-semibold tracking-tight">
            SEO Keyword Tracker
          </Link>
          <div className="flex items-center gap-6">
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
