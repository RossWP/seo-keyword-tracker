import { fireEvent, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, fakeApi, json, signedInAs } from '../../test/fake-api';
import { renderRoute } from '../../test/render-route';

const clients = {
  items: [
    {
      id: 'c1',
      name: 'Semrush',
      websiteUrl: 'https://www.semrush.com/',
      crawlStatus: 'done',
      crawlErrorCode: null,
      crawlErrorMessage: null,
      pagesTotal: 15,
      pagesDone: 15,
      sitemapUrl: null,
      createdAt: '2026-10-07T10:00:00.000Z',
      crawlFinishedAt: null,
    },
    {
      id: 'c2',
      name: 'Acme',
      websiteUrl: 'https://acme.example/',
      crawlStatus: 'crawling',
      crawlErrorCode: null,
      crawlErrorMessage: null,
      pagesTotal: 15,
      pagesDone: 7,
      sitemapUrl: null,
      createdAt: '2026-10-07T10:00:00.000Z',
      crawlFinishedAt: null,
    },
  ],
};

const page = (n: number) => ({
  id: `p${n}`,
  url: `https://www.semrush.com/blog/post-${n}/`,
  title: `Post ${n}`,
  fetchStatus: 'ok',
  client: { id: 'c1', name: 'Semrush' },
  issueCount: 2,
  errorCount: 1,
  bestPosition: 4,
  keywords: [{ id: n, term: `keyword ${n}`, position: 4, date: '2026-10-06' }],
});

function pagesApi(handler: (url: URL) => unknown) {
  const requests: URL[] = [];
  fakeApi({
    ...signedInAs(),
    'GET /api/clients': () => json(200, clients),
    'GET /api/pages': ({ url }) => {
      requests.push(url);
      const result = handler(url);
      return result instanceof Response ? result : json(200, result);
    },
  });
  return requests;
}

describe('pages list', () => {
  it('shows pages with keyword positions, issue counts and crawl progress', async () => {
    pagesApi(() => ({ items: [page(1)], page: 1, pageSize: 20, total: 1 }));
    renderRoute('/');

    expect(await screen.findByRole('link', { name: 'Post 1' })).toHaveAttribute(
      'href',
      '/pages/p1',
    );
    expect(screen.getByText('keyword 1')).toBeInTheDocument();
    expect(screen.getAllByText('#4')).toHaveLength(2);
    expect(screen.getByText('(1 error)')).toBeInTheDocument();
    expect(await screen.findByText(/Crawling Acme: 7 of 15 pages/)).toBeInTheDocument();
  });

  it('keeps search, client filter and page in the URL and sends them to the API', async () => {
    const requests = pagesApi(() => ({ items: [page(1)], page: 1, pageSize: 20, total: 45 }));
    const { router } = renderRoute('/');
    const user = userEvent.setup();

    await screen.findByText('Post 1');
    await user.selectOptions(screen.getByRole('combobox'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?clientId=c1&page=2');
    });

    fireEvent.change(screen.getByPlaceholderText('Search URL or keyword'), {
      target: { value: ' seo ' },
    });
    await waitFor(() => {
      expect(router.state.location.search).toBe('?clientId=c1&q=seo');
    });
    await waitFor(() => {
      const last = requests.at(-1);
      expect(last?.searchParams.get('q')).toBe('seo');
      expect(last?.searchParams.get('page')).toBe('1');
    });
  });

  it('offers to clear a search with no results', async () => {
    pagesApi(() => ({ items: [], page: 1, pageSize: 20, total: 0 }));
    renderRoute('/?q=nothing');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Clear search' }));
    expect(screen.getByPlaceholderText('Search URL or keyword')).toHaveValue('');
  });

  it('explains a client id that is not yours', async () => {
    pagesApi(() => apiError(404, 'not_found', 'Client not found'));
    renderRoute('/?clientId=someone-elses');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That client doesn't exist or isn't yours",
    );
  });
});
