import { Link, NavLink, Outlet } from 'react-router';
import { useSession } from '../features/auth/auth-api';
import { UserMenu } from '../features/auth/user-menu';
import { ApiStatus } from '../features/status/api-status';

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'font-medium text-slate-900' : 'text-slate-600 hover:text-slate-900';

export function AppLayout() {
  const session = useSession();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="font-semibold tracking-tight">
              SEO Keyword Tracker
            </Link>
            {session.data && (
              <nav className="flex gap-4 text-sm" aria-label="Main">
                <NavLink to="/" end className={navClass}>
                  Pages
                </NavLink>
                <NavLink to="/clients" className={navClass}>
                  Clients
                </NavLink>
              </nav>
            )}
          </div>
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
