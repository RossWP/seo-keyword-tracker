import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { isApiError } from '../../api/client';
import { PositionBadge } from '../../components/position-badge';
import { useSession } from '../auth/auth-api';
import { NotFoundPage } from '../../app/not-found-page';
import { addDays, isIsoDate, todayIn } from './dates';
import { usePageDetail, usePageHistory, type PageDetail } from './page-detail-api';
import { RankChart, RankTable, seriesColor } from './rank-chart';

const PRESETS = [7, 30, 90, 365] as const;
const DEFAULT_DAYS = 90;
const DEFAULT_SELECTED = 3;
const SOURCE_LABELS: Record<string, string> = {
  title: 'title',
  h1: 'H1',
  slug: 'URL',
  schema: 'structured data',
  heading: 'headings',
  meta: 'meta description',
  intro: 'intro',
  body: 'body text',
};

export function PageDetailPage() {
  const { pageId = '' } = useParams();
  const page = usePageDetail(pageId);

  if (page.isPending) return <p className="text-slate-500">Loading page…</p>;
  if (page.isError) {
    if (isApiError(page.error, 404)) return <NotFoundPage />;
    return (
      <p role="alert" className="text-red-700">
        Could not load this page: {page.error.message}{' '}
        <button type="button" className="underline" onClick={() => void page.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  return <PageDetailView page={page.data} />;
}

function PageDetailView({ page }: { page: PageDetail }) {
  return (
    <article className="space-y-8">
      <header>
        <Link
          to={`/?clientId=${page.client.id}`}
          className="text-sm text-slate-500 hover:underline"
        >
          ← {page.client.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{page.title ?? page.url}</h1>
        <a
          href={page.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm break-all text-blue-700 hover:underline"
        >
          {page.url}
        </a>
        {page.fetchStatus !== 'ok' && (
          <p role="alert" className="mt-3 rounded-md bg-amber-50 px-4 py-2 text-sm text-amber-900">
            This page could not be analysed ({page.fetchStatus.replace('_', ' ')}):{' '}
            {page.fetchError}
          </p>
        )}
      </header>

      <RankHistorySection page={page} />

      <section>
        <h2 className="text-lg font-semibold">Keywords</h2>
        {page.keywords.length === 0 ? (
          <p className="mt-2 text-slate-600">No keywords were found on this page.</p>
        ) : (
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-slate-600">
              <tr>
                <th className="py-2 font-medium">Keyword</th>
                <th className="py-2 font-medium">Found in</th>
                <th className="py-2 font-medium">Latest position</th>
              </tr>
            </thead>
            <tbody>
              {page.keywords.map((keyword) => (
                <tr key={keyword.id} className="border-t border-slate-100">
                  <td className="py-2 font-medium">{keyword.term}</td>
                  <td className="py-2 text-slate-600">
                    {keyword.sources.map((source) => SOURCE_LABELS[source] ?? source).join(', ')}
                  </td>
                  <td className="py-2">
                    <PositionBadge position={keyword.position} date={keyword.date} />{' '}
                    <span className="text-xs text-slate-500">
                      {keyword.date ?? 'no history yet'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <IssuesSection issues={page.issues} />
    </article>
  );
}

/** Range and selected keywords live in the URL: ?from=2026-07-01&to=2026-10-06&kw=12,15 */
function RankHistorySection({ page }: { page: PageDetail }) {
  const session = useSession();
  const timezone = session.data?.timezone ?? 'America/Toronto';
  const today = todayIn(timezone);
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'chart' | 'table'>('chart');

  const from = isIsoDate(params.get('from'))
    ? (params.get('from') ?? '')
    : addDays(today, -(DEFAULT_DAYS - 1));
  const to = isIsoDate(params.get('to')) ? (params.get('to') ?? '') : today;
  const selectedParam = params.get('kw');
  const selected = new Set(
    selectedParam === null
      ? page.keywords.slice(0, DEFAULT_SELECTED).map((keyword) => keyword.id)
      : selectedParam.split(',').map(Number).filter(Number.isInteger),
  );
  const colorIndex = new Map(page.keywords.map((keyword, index) => [keyword.id, index]));
  const history = usePageHistory(page.id, from <= to ? { from, to } : null);

  const setParam = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) next.set(key, value);
    setParams(next, { replace: true });
  };
  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setParam({ kw: [...next].join(',') });
  };

  const shown = history.data?.series.filter((line) => selected.has(line.keywordId)) ?? [];
  const hasPoints = shown.some((line) => line.points.length > 0);
  const activePreset =
    to === today ? PRESETS.find((days) => addDays(today, -(days - 1)) === from) : undefined;

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Position history</h2>
          <p className="text-xs text-slate-500">
            Dates in {timezone.replace('_', ' ')} time · lower is better
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          {PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              aria-pressed={activePreset === days}
              onClick={() => {
                setParam({ from: addDays(today, -(days - 1)), to: today });
              }}
              className={`rounded-md border px-2 py-1 ${activePreset === days ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300'}`}
            >
              {days === 365 ? '1y' : `${days}d`}
            </button>
          ))}
          <label className="flex flex-col text-xs text-slate-600">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => {
                if (isIsoDate(event.target.value)) setParam({ from: event.target.value });
              }}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
            />
          </label>
          <label className="flex flex-col text-xs text-slate-600">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(event) => {
                if (isIsoDate(event.target.value)) setParam({ to: event.target.value });
              }}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
            />
          </label>
        </div>
      </div>

      {page.keywords.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Keywords shown in the chart">
          {page.keywords.map((keyword) => {
            const on = selected.has(keyword.id);
            return (
              <button
                key={keyword.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  toggle(keyword.id);
                }}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm ${on ? 'border-slate-400 bg-white' : 'border-slate-200 text-slate-400'}`}
              >
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{
                    backgroundColor: on ? seriesColor(colorIndex.get(keyword.id) ?? 0) : '#d6d3d1',
                  }}
                />
                {keyword.term}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        {from > to ? (
          <p role="alert">The start date is after the end date.</p>
        ) : history.isPending ? (
          <p className="text-slate-500">Loading history…</p>
        ) : history.isError ? (
          <p role="alert" className="text-red-700">
            {history.error.message}{' '}
            <button type="button" className="underline" onClick={() => void history.refetch()}>
              Try again
            </button>
          </p>
        ) : shown.length === 0 ? (
          <p className="text-slate-600">Select a keyword above to see its positions.</p>
        ) : !hasPoints ? (
          <p className="text-slate-600">
            No rank data in this range.{' '}
            {page.keywords.every((keyword) => keyword.date === null) &&
              'This page has no history yet: snapshots are added when the seed runs again (pnpm seed).'}
          </p>
        ) : (
          <>
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setView(view === 'chart' ? 'table' : 'chart');
                }}
                className="text-sm text-blue-700 underline"
              >
                {view === 'chart' ? 'Show as table' : 'Show as chart'}
              </button>
            </div>
            <div className={history.isPlaceholderData ? 'opacity-60' : ''}>
              {view === 'chart' ? (
                <RankChart series={shown} colorIndex={colorIndex} />
              ) : (
                <RankTable series={shown} />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function IssuesSection({ issues }: { issues: PageDetail['issues'] }) {
  const groups = [
    { severity: 'error', label: 'Errors', tone: 'text-red-700' },
    { severity: 'warning', label: 'Warnings', tone: 'text-amber-700' },
    { severity: 'notice', label: 'Notices', tone: 'text-slate-600' },
  ] as const;
  return (
    <section>
      <h2 className="text-lg font-semibold">SEO issues</h2>
      {issues.length === 0 ? (
        <p className="mt-2 text-slate-600">No issues found.</p>
      ) : (
        groups.map(({ severity, label, tone }) => {
          const items = issues.filter((found) => found.severity === severity);
          if (items.length === 0) return null;
          return (
            <div key={severity} className="mt-3">
              <h3 className={`text-sm font-semibold ${tone}`}>
                {label} ({items.length})
              </h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {items.map((found) => (
                  <li key={found.code}>{found.message}</li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}
