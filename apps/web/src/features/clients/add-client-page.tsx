import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { fieldErrors, isApiError } from '../../api/client';
import { useCreateClient } from './clients-api';

/** Mirrors the server rule so obvious mistakes are caught before a round trip. */
function checkUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return 'Enter the website URL';
  if (!/^https?:\/\//i.test(trimmed))
    return 'Start with http:// or https://, like https://example.com';
  try {
    new URL(trimmed);
    return null;
  } catch {
    return 'Enter a full website address, like https://example.com';
  }
}

export function AddClientPage() {
  const create = useCreateClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  const serverErrors = fieldErrors(create.error);
  const errors = { ...serverErrors, ...localErrors };
  const duplicate = isApiError(create.error, 409) ? create.error : null;
  const duplicateId =
    duplicate &&
    typeof duplicate.details === 'object' &&
    duplicate.details !== null &&
    'clientId' in duplicate.details
      ? String(duplicate.details.clientId)
      : null;

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (name.trim() === '') nextErrors.name = 'Enter a name';
    const urlError = checkUrl(websiteUrl);
    if (urlError) nextErrors.websiteUrl = urlError;
    setLocalErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    create.mutate(
      { name: name.trim(), websiteUrl: websiteUrl.trim() },
      { onSuccess: () => void navigate('/clients') },
    );
  };

  return (
    <section className="mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold">Add client</h1>
      <p className="mt-2 text-sm text-slate-600">
        We find the blog sitemap, crawl the first 15 posts and extract keywords and SEO issues. This
        takes a minute or two and runs in the background.
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        <Field label="Client name" error={errors.name}>
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            maxLength={100}
            aria-invalid={Boolean(errors.name)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </Field>
        <Field label="Website URL" error={errors.websiteUrl}>
          <input
            type="url"
            inputMode="url"
            placeholder="https://example.com"
            value={websiteUrl}
            onChange={(event) => {
              setWebsiteUrl(event.target.value);
            }}
            aria-invalid={Boolean(errors.websiteUrl)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </Field>

        {duplicate && (
          <p role="alert" className="text-sm text-red-700">
            {duplicate.message}.{' '}
            {duplicateId && (
              <Link to={`/?clientId=${duplicateId}`} className="underline">
                View its pages
              </Link>
            )}
          </p>
        )}
        {create.isError && !duplicate && Object.keys(serverErrors).length === 0 && (
          <p role="alert" className="text-sm text-red-700">
            {create.error.message}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60"
          >
            {create.isPending ? 'Adding…' : 'Add and crawl'}
          </button>
          <Link to="/clients" className="px-2 py-2 text-slate-600">
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error: string | undefined;
  children: React.ReactNode;
}) {
  // The error sits outside the label so the field's accessible name stays just its label.
  return (
    <div>
      <label className="block">
        <span className="text-sm font-medium">{label}</span>
        {children}
      </label>
      {error && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
