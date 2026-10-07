import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, fakeApi, json, signedInAs } from '../../test/fake-api';
import { renderRoute } from '../../test/render-route';

const client = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Acme',
  websiteUrl: 'https://acme.example/',
  crawlStatus: 'pending',
  crawlErrorCode: null,
  crawlErrorMessage: null,
  pagesTotal: 0,
  pagesDone: 0,
  sitemapUrl: null,
  createdAt: '2026-10-07T10:00:00.000Z',
  crawlFinishedAt: null,
  ...overrides,
});

async function fillForm(name: string, url: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Client name'), name);
  await user.type(screen.getByLabelText('Website URL'), url);
  await user.click(screen.getByRole('button', { name: 'Add and crawl' }));
}

describe('add client', () => {
  it('creates the client and shows its crawl status on the clients page', async () => {
    let created = false;
    const fetchMock = fakeApi({
      ...signedInAs(),
      'POST /api/clients': () => {
        created = true;
        return json(202, client());
      },
      'GET /api/clients': () => json(200, { items: created ? [client()] : [] }),
    });
    const { router } = renderRoute('/clients/new');

    await fillForm('Acme', 'https://acme.example');

    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/clients');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/clients',
      expect.objectContaining({
        body: JSON.stringify({ name: 'Acme', websiteUrl: 'https://acme.example' }),
      }),
    );
  });

  it('catches a URL without a scheme before sending it', async () => {
    const fetchMock = fakeApi(signedInAs());
    renderRoute('/clients/new');
    await fillForm('Acme', 'acme.example');
    expect(await screen.findByText(/Start with http:\/\/ or https:\/\//)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/clients', expect.anything());
  });

  it('shows the server reason on the URL field', async () => {
    fakeApi({
      ...signedInAs(),
      'POST /api/clients': () =>
        json(400, {
          error: {
            code: 'blocked_host',
            message: 'Private and internal addresses cannot be crawled',
            details: {
              issues: [
                {
                  path: 'body.websiteUrl',
                  message: 'Private and internal addresses cannot be crawled',
                },
              ],
            },
          },
        }),
    });
    renderRoute('/clients/new');
    await fillForm('Internal', 'http://10.0.0.5/');
    expect(
      await screen.findByText('Private and internal addresses cannot be crawled'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Website URL')).toHaveAttribute('aria-invalid', 'true');
  });

  it('links to the existing client for a duplicate site', async () => {
    fakeApi({
      ...signedInAs(),
      'POST /api/clients': () =>
        json(409, {
          error: {
            code: 'duplicate_site',
            message: 'You already track this site as "Acme"',
            details: { clientId: 'c1' },
          },
        }),
    });
    renderRoute('/clients/new');
    await fillForm('Acme again', 'https://www.acme.example');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You already track this site as "Acme"',
    );
    expect(screen.getByRole('link', { name: 'View its pages' })).toHaveAttribute(
      'href',
      '/?clientId=c1',
    );
  });
});

describe('clients page', () => {
  it('explains a failed crawl and retries it', async () => {
    let retried = false;
    fakeApi({
      ...signedInAs(),
      'GET /api/clients': () =>
        json(200, {
          items: [
            retried ? client() : client({ crawlStatus: 'failed', crawlErrorCode: 'no_sitemap' }),
          ],
        }),
      'POST /api/clients/c1/recrawl': () => {
        retried = true;
        return json(202, client());
      },
    });
    renderRoute('/clients');

    expect(await screen.findByText(/No sitemap was found/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
  });

  it('reports a crawl that is already running', async () => {
    fakeApi({
      ...signedInAs(),
      'GET /api/clients': () => json(200, { items: [client({ crawlStatus: 'done' })] }),
      'POST /api/clients/c1/recrawl': () =>
        apiError(409, 'crawl_in_progress', 'This client is already being crawled'),
    });
    renderRoute('/clients');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Crawl again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already being crawled');
  });
});
