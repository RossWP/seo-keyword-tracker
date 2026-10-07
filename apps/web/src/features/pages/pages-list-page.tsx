import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { isApiError } from '../../api/client';
import { PositionBadge } from '../../components/position-badge';
import { isCrawling, useClients } from '../clients/clients-api';
import { PAGE_SIZE, usePages, type PageListItem } from './pages-api';

const SEARCH_DEBOUNCE_MS = 300;

/** Filters, search and page number live in the URL, so refresh, bookmarks and Back all work. */
function useListParams() {
  const [params, setParams] = useSearchParams();
  const pageNumber = Number(params.get('page'));
  const values = {
    clientId: params.get('clientId') ?? '',
    q: params.get('q') ?? '',
    page: Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : 1,
  };
  const update = (changes: Partial<typeof values>) => {
    const next = { ...values, page: 1, ...changes };
    const search = new URLSearchParams();
    if (next.clientId) search.set('clientId', next.clientId);
    if (next.q) search.set('q', next.q);
    if (next.page > 1) search.set('page', String(next.page));
    setParams(search);
  };
  return [values, update] as const;
}

export function PagesListPage() {
  const [params, update] = useListParams();
  const clients = useClients();
  const pages = usePages(params);
  const [searchText, setSearchText] = useState(params.q);
  // Back/forward or a link can change the search in the URL: show that text in the box.
  const [shownQuery, setShownQuery] = useState(params.q);
  if (shownQuery !== params.q) {
    setShownQuery(params.q);
    if (searchText.trim() !== params.q) setSearchText(params.q);
  }

  // Typing updates the URL once it pauses, so each finished search (not each keystroke) is a
  // history entry that Back can return to.
  useEffect(() => {
    if (searchText.trim() === params.q) return;
    const timer = setTimeout(() => {
      update({ q: searchText.trim() });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  const crawling = clients.data?.filter((client) => isCrawling(client.crawlStatus)) ?? [];
  const total = pages.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold">Pages</h1>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">
            <span className="sr-only">Client</span>
            <select
              value={params.clientId}
              onChange={(event) => {
                update({ clientId: event.target.value });
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-2"
            >
              <option value="">All clients</option>
              {clients.data?.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="sr-only">Search by URL or keyword</span>
            <input
              type="search"
              value={searchText}
              onChange={(event) => {
                setSearchText(event.target.value);
              }}
              placeholder="Search URL or keyword"
              maxLength={200}
              className="w-64 rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
        </div>
      </div>

      {crawling.map((client) => (
        <p
          key={client.id}
          role="status"
          className="mt-4 rounded-md bg-sky-50 px-4 py-2 text-sm text-sky-900"
        >
          Crawling {client.name}: {client.pagesDone} of {client.pagesTotal || '…'} pages. New pages
          appear here when it finishes.
        </p>
      ))}

      <div className="mt-6">
        {pages.isPending ? (
          <p className="text-slate-500">Loading pages…</p>
        ) : pages.isError ? (
          isApiError(pages.error, 404) ? (
            <p role="alert">
              That client doesn&apos;t exist or isn&apos;t yours.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  update({ clientId: '' });
                }}
              >
                Show all clients
              </button>
            </p>
          ) : (
            <p role="alert" className="text-red-700">
              Could not load pages: {pages.error.message}{' '}
              <button type="button" className="underline" onClick={() => void pages.refetch()}>
                Try again
              </button>
            </p>
          )
        ) : total === 0 ? (
          <EmptyState
            searching={params.q !== ''}
            noClients={clients.data?.length === 0}
            onClear={() => {
              setSearchText('');
              update({ q: '' });
            }}
          />
        ) : (
          <>
            <PagesTable items={pages.data.items} stale={pages.isPlaceholderData} />
            <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
              <span className="text-slate-600">
                {(params.page - 1) * PAGE_SIZE + 1}–{Math.min(params.page * PAGE_SIZE, total)} of{' '}
                {total} pages
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={params.page <= 1}
                  onClick={() => {
                    update({ ...params, page: params.page - 1 });
                  }}
                  className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={params.page >= lastPage}
                  onClick={() => {
                    update({ ...params, page: params.page + 1 });
                  }}
                  className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </span>
            </nav>
          </>
        )}
      </div>
    </section>
  );
}

function EmptyState({
  searching,
  noClients,
  onClear,
}: {
  searching: boolean;
  noClients: boolean;
  onClear: () => void;
}) {
  if (searching) {
    return (
      <p>
        No pages match your search.{' '}
        <button type="button" className="underline" onClick={onClear}>
          Clear search
        </button>
      </p>
    );
  }
  return (
    <p className="text-slate-600">
      {noClients ? (
        <>
          No clients yet.{' '}
          <Link to="/clients/new" className="text-blue-700 underline">
            Add a client
          </Link>{' '}
          to start tracking its blog.
        </>
      ) : (
        'No pages crawled yet.'
      )}
    </p>
  );
}

function PagesTable({ items, stale }: { items: PageListItem[]; stale: boolean }) {
  return (
    <div
      className={`overflow-x-auto rounded-lg border border-slate-200 bg-white ${stale ? 'opacity-60' : ''}`}
    >
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
          <tr>
            <th className="px-4 py-2 font-medium">Page</th>
            <th className="px-4 py-2 font-medium">Keywords (latest position)</th>
            <th className="px-4 py-2 font-medium">Best</th>
            <th className="px-4 py-2 font-medium">Issues</th>
          </tr>
        </thead>
        <tbody>
          {items.map((page) => (
            <tr key={page.id} className="border-b border-slate-100 align-top last:border-0">
              <td className="max-w-sm px-4 py-3">
                <Link
                  to={`/pages/${page.id}`}
                  className="font-medium text-slate-900 hover:underline"
                >
                  {page.title ?? page.url}
                </Link>
                <div className="truncate text-xs text-slate-500" title={page.url}>
                  {page.client.name} · {page.url}
                </div>
                {page.fetchStatus !== 'ok' && (
                  <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 text-xs text-amber-800">
                    {page.fetchStatus.replace('_', ' ')}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <ul className="flex flex-wrap gap-1.5">
                  {page.keywords.map((keyword) => (
                    <li
                      key={keyword.id}
                      className="flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5"
                    >
                      <span>{keyword.term}</span>
                      <PositionBadge position={keyword.position} date={keyword.date} />
                    </li>
                  ))}
                  {page.keywords.length === 0 && <li className="text-slate-400">No keywords</li>}
                </ul>
              </td>
              <td className="px-4 py-3">
                <PositionBadge position={page.bestPosition} />
              </td>
              <td className="px-4 py-3 tabular-nums">
                {page.issueCount === 0 ? (
                  <span className="text-slate-400">0</span>
                ) : (
                  <span className={page.errorCount > 0 ? 'text-red-700' : 'text-amber-700'}>
                    {page.issueCount}
                    {page.errorCount > 0 && (
                      <span className="text-xs">
                        {' '}
                        ({page.errorCount} {page.errorCount === 1 ? 'error' : 'errors'})
                      </span>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
