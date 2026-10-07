import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../test/render-route';

function stubHealth(response: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(response));
}

const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

describe('app shell', () => {
  it('shows the API as connected when health is ok', async () => {
    stubHealth(() => json(200, { status: 'ok', database: 'up' }));
    renderRoute('/');
    expect(await screen.findByText('API connected')).toBeInTheDocument();
  });

  it('shows a database problem when health returns 503', async () => {
    stubHealth(() => json(503, { status: 'unavailable', database: 'down' }));
    renderRoute('/');
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
  });

  it('shows the API as unreachable when the request fails', async () => {
    stubHealth(() => Promise.reject(new TypeError('Failed to fetch')));
    renderRoute('/');
    expect(await screen.findByText('API unreachable')).toBeInTheDocument();
  });

  it('renders the not-found page for unknown routes', async () => {
    stubHealth(() => json(200, { status: 'ok', database: 'up' }));
    renderRoute('/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
