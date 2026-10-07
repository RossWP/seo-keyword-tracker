import { useState, type SubmitEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { isApiError } from '../../api/client';
import { useLogin, useSession } from './auth-api';
import { safeReturnTo } from './return-to';

export function LoginPage() {
  const session = useSession();
  const login = useLogin();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (session.data) return <Navigate to={returnTo} replace />;

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    login.mutate(
      { email, password },
      { onSuccess: () => void navigate(returnTo, { replace: true }) },
    );
  };

  const error = login.error;
  const errorMessage = !error
    ? null
    : isApiError(error, 400)
      ? 'Enter a valid email and your password.'
      : error.message;

  return (
    <section className="mx-auto max-w-sm">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        {errorMessage && (
          <p role="alert" className="text-sm text-red-700">
            {errorMessage}
          </p>
        )}
        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded-md bg-slate-900 px-3 py-2 font-medium text-white disabled:opacity-60"
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}
