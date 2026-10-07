import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, fakeApi, json, signedInAs } from '../test/fake-api';
import { renderRoute } from '../test/render-route';

describe('API status', () => {
  it('shows the API as connected when health is ok', async () => {
    fakeApi();
    renderRoute('/login');
    expect(await screen.findByText('API connected')).toBeInTheDocument();
  });

  it('shows a database problem when health returns 503', async () => {
    fakeApi({ 'GET /health': () => json(503, { status: 'unavailable', database: 'down' }) });
    renderRoute('/login');
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
  });

  it('shows the API as unreachable when the request fails', async () => {
    fakeApi({ 'GET /health': () => Promise.reject(new TypeError('Failed to fetch')) });
    renderRoute('/login');
    expect(await screen.findByText('API unreachable')).toBeInTheDocument();
  });
});

describe('routing', () => {
  it('renders the not-found page for unknown routes when signed in', async () => {
    fakeApi(signedInAs());
    renderRoute('/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('explains when the session cannot be checked', async () => {
    fakeApi({ 'GET /api/auth/me': () => apiError(500, 'internal_error', 'Something went wrong') });
    renderRoute('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check your session');
  });
});
