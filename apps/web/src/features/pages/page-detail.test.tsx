import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, fakeApi, json, signedInAs, type FakeHandler } from '../../test/fake-api';
import { renderRoute } from '../../test/render-route';

const detail = {
  id: 'p1',
  url: 'https://www.semrush.com/blog/keyword-research/',
  finalUrl: null,
  title: 'Keyword Research Guide',
  metaDescription: null,
  h1: 'Keyword Research',
  wordCount: 1200,
  fetchStatus: 'ok',
  fetchError: null,
  httpStatus: 200,
  fetchedAt: '2026-10-07T10:00:00Z',
  client: { id: 'c1', name: 'Semrush' },
  keywords: [
    {
      id: 11,
      term: 'keyword research',
      score: 20,
      sources: ['title', 'h1', 'slug'],
      position: 4,
      date: '2026-10-06',
    },
    {
      id: 12,
      term: 'keyword tools',
      score: 9,
      sources: ['heading', 'body'],
      position: null,
      date: '2026-10-06',
    },
  ],
  issues: [
    { code: 'h1_missing', severity: 'error', message: 'Page has no H1 heading', details: null },
    {
      code: 'thin_content',
      severity: 'warning',
      message: 'Only 120 words of main content',
      details: { words: 120 },
    },
  ],
};

const history = (from: string, to: string) => ({
  timezone: 'America/Toronto',
  from,
  to,
  series: [
    {
      keywordId: 11,
      term: 'keyword research',
      points: [
        { date: '2026-10-05', position: 6 },
        { date: '2026-10-06', position: 4 },
      ],
    },
    { keywordId: 12, term: 'keyword tools', points: [{ date: '2026-10-06', position: null }] },
  ],
});

function detailApi(overrides: Record<string, FakeHandler> = {}) {
  const historyRequests: URL[] = [];
  fakeApi({
    ...signedInAs(),
    'GET /api/pages/p1': () => json(200, detail),
    'GET /api/pages/p1/rankings': ({ url }) => {
      historyRequests.push(url);
      return json(
        200,
        history(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? ''),
      );
    },
    ...overrides,
  });
  return historyRequests;
}

describe('page detail', () => {
  it('shows keywords with where they were found, and issues grouped by severity', async () => {
    detailApi();
    renderRoute('/pages/p1');

    expect(
      await screen.findByRole('heading', { name: 'Keyword Research Guide' }),
    ).toBeInTheDocument();
    expect(screen.getByText('title, H1, URL')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Errors (1)' })).toBeInTheDocument();
    expect(screen.getByText('Only 120 words of main content')).toBeInTheDocument();
  });

  it('loads the last 90 days by default and lists the values in the table view', async () => {
    const requests = detailApi();
    renderRoute('/pages/p1');

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table', { name: 'Position history' });
    expect(within(table).getByText('#4')).toBeInTheDocument();
    expect(within(table).getByText('—')).toBeInTheDocument();
    const [first] = requests;
    const days =
      (Date.parse(first?.searchParams.get('to') ?? '') -
        Date.parse(first?.searchParams.get('from') ?? '')) /
      86_400_000;
    expect(days).toBe(89);
  });

  it('keeps the range and keyword selection in the URL', async () => {
    const requests = detailApi();
    const { router } = renderRoute('/pages/p1?from=2026-09-01&to=2026-10-06');
    const user = userEvent.setup();

    await screen.findByRole('button', { name: 'Show as table' });
    expect(requests[0]?.searchParams.get('from')).toBe('2026-09-01');

    await user.click(screen.getByRole('button', { name: 'keyword tools' }));
    expect(router.state.location.search).toContain('kw=11');
    expect(router.state.location.search).not.toContain('12');

    await user.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => {
      expect(requests.at(-1)?.searchParams.get('from')).not.toBe('2026-09-01');
    });
  });

  it('shows the not-found page for a page that is not yours', async () => {
    detailApi({ 'GET /api/pages/p1': () => apiError(404, 'not_found', 'Page not found') });
    renderRoute('/pages/p1');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
