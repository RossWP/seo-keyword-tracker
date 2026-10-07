import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-slate-600">
        This page doesn&apos;t exist or you don&apos;t have access to it.
      </p>
      <Link to="/" className="mt-4 inline-block text-blue-700 underline">
        Back to start
      </Link>
    </section>
  );
}
