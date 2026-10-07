import { Link } from 'react-router';
import { isApiError } from '../../api/client';
import { CRAWL_ERRORS, isCrawling, useClients, useRecrawl, type Client } from './clients-api';

const STATUS: Record<Client['crawlStatus'], { label: string; tone: string }> = {
  pending: { label: 'Queued', tone: 'bg-slate-100 text-slate-700' },
  discovering: { label: 'Finding blog sitemap', tone: 'bg-sky-100 text-sky-800' },
  crawling: { label: 'Crawling', tone: 'bg-sky-100 text-sky-800' },
  done: { label: 'Done', tone: 'bg-emerald-100 text-emerald-800' },
  partial: { label: 'Done with problems', tone: 'bg-amber-100 text-amber-800' },
  failed: { label: 'Failed', tone: 'bg-red-100 text-red-800' },
};

export function ClientsPage() {
  const clients = useClients();
  const recrawl = useRecrawl();

  return (
    <section>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Clients</h1>
        <Link
          to="/clients/new"
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
        >
          Add client
        </Link>
      </div>

      {recrawl.isError && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {isApiError(recrawl.error, 409)
            ? 'That client is already being crawled.'
            : recrawl.error.message}
        </p>
      )}

      <div className="mt-6">
        {clients.isPending ? (
          <p className="text-slate-500">Loading clients…</p>
        ) : clients.isError ? (
          <p role="alert" className="text-red-700">
            Could not load clients: {clients.error.message}{' '}
            <button type="button" className="underline" onClick={() => void clients.refetch()}>
              Try again
            </button>
          </p>
        ) : clients.data.length === 0 ? (
          <p className="text-slate-600">No clients yet. Add one to start tracking its blog.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {clients.data.map((client) => {
              const status = STATUS[client.crawlStatus];
              const running = isCrawling(client.crawlStatus);
              return (
                <li
                  key={client.id}
                  className="flex flex-wrap items-start justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <Link to={`/?clientId=${client.id}`} className="font-medium hover:underline">
                      {client.name}
                    </Link>
                    <div className="truncate text-sm text-slate-500">{client.websiteUrl}</div>
                    {client.crawlErrorCode && (
                      <p className="mt-1 text-sm text-slate-700">
                        {CRAWL_ERRORS[client.crawlErrorCode] ?? client.crawlErrorMessage}
                      </p>
                    )}
                    {client.crawlStatus === 'partial' && !client.crawlErrorCode && (
                      <p className="mt-1 text-sm text-slate-700">{client.crawlErrorMessage}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span
                      role="status"
                      className={`rounded px-2 py-0.5 text-xs font-medium ${status.tone}`}
                    >
                      {status.label}
                      {client.crawlStatus === 'crawling' &&
                        ` ${client.pagesDone}/${client.pagesTotal}`}
                    </span>
                    {!running && (
                      <button
                        type="button"
                        disabled={recrawl.isPending}
                        onClick={() => {
                          recrawl.mutate(client.id);
                        }}
                        className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
                      >
                        {client.crawlStatus === 'failed' ? 'Retry' : 'Crawl again'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
