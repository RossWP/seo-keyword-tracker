import { Navigate, Outlet, useLocation } from 'react-router';
import { useSession } from './auth-api';

/** Layout route: renders its children only for a signed-in user, otherwise sends them to login. */
export function RequireAuth() {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) {
    return <p className="text-slate-500">Loading…</p>;
  }
  if (session.isError) {
    return (
      <div role="alert" className="text-red-700">
        Could not check your session. {session.error.message}{' '}
        <button type="button" className="underline" onClick={() => void session.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (!session.data) {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return <Outlet />;
}
