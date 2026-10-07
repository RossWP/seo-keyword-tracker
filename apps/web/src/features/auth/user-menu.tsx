import { useLogout, useSession } from './auth-api';

export function UserMenu() {
  const session = useSession();
  const logout = useLogout();
  if (!session.data) return null;

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-slate-600">{session.data.email}</span>
      <button
        type="button"
        onClick={() => {
          logout.mutate();
        }}
        disabled={logout.isPending}
        className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-60"
      >
        Sign out
      </button>
    </div>
  );
}
