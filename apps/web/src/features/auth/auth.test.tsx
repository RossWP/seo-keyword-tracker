import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, fakeApi, json, signedInAs } from '../../test/fake-api';
import { renderRoute } from '../../test/render-route';
import { safeReturnTo } from './return-to';

const alice = {
  id: '0b6f3c9e-1d1f-4c8e-9a51-6f0d1f2b8a11',
  email: 'alice@agency.test',
  timezone: 'America/Toronto',
};

async function signIn(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('sign in', () => {
  it('sends a signed-out visitor to login and back to the page they wanted', async () => {
    const fetchMock = fakeApi({ 'POST /api/auth/login': () => json(200, { user: alice }) });
    const { router } = renderRoute('/missing-page?tab=2');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.search).toBe(
      `?returnTo=${encodeURIComponent('/missing-page?tab=2')}`,
    );

    await signIn('alice@agency.test', 'demo-password');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/missing-page');
    expect(screen.getByText('alice@agency.test')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'alice@agency.test', password: 'demo-password' }),
      }),
    );
  });

  it('shows the server message for wrong credentials and stays on login', async () => {
    fakeApi({
      'POST /api/auth/login': () =>
        apiError(401, 'invalid_credentials', 'Email or password is incorrect'),
    });
    renderRoute('/login');

    await signIn('alice@agency.test', 'wrong');

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('explains rate limiting', async () => {
    fakeApi({
      'POST /api/auth/login': () =>
        apiError(429, 'rate_limited', 'Too many sign-in attempts. Try again in a minute.'),
    });
    renderRoute('/login');
    await signIn('alice@agency.test', 'wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sign-in attempts');
  });

  it('skips the form for a visitor who is already signed in', async () => {
    fakeApi(signedInAs());
    const { router } = renderRoute('/login');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });
});

describe('sign out', () => {
  it('ends the session and returns to login', async () => {
    let signedIn = true;
    fakeApi({
      'GET /api/auth/me': () =>
        signedIn
          ? json(200, { user: alice })
          : apiError(401, 'unauthorized', 'Sign in to continue'),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    renderRoute('/');

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('alice@agency.test')).not.toBeInTheDocument();
  });
});

describe('switching users', () => {
  it("never shows the previous user's cached data after their session expires", async () => {
    const bob = { ...alice, id: '5d0c4c7a-8a43-4c8f-a3b4-0d6a1f8e2c19', email: 'bob@agency.test' };
    let current: typeof alice | null = alice;
    const clientOf = (name: string) => ({
      id: name === 'Semrush' ? 'c1' : 'c2',
      name,
      websiteUrl: `https://${name.toLowerCase()}.example/`,
      crawlStatus: 'done',
      crawlErrorCode: null,
      crawlErrorMessage: null,
      pagesTotal: 1,
      pagesDone: 1,
      sitemapUrl: null,
      createdAt: '2026-10-07T10:00:00.000Z',
      crawlFinishedAt: null,
    });
    const pageOf = (name: string) => ({
      id: name === 'Semrush' ? 'p1' : 'p2',
      url: `https://${name.toLowerCase()}.example/blog/post/`,
      title: `${name} post`,
      fetchStatus: 'ok',
      client: { id: name === 'Semrush' ? 'c1' : 'c2', name },
      issueCount: 0,
      errorCount: 0,
      bestPosition: null,
      keywords: [],
    });
    const unauthorized = () => apiError(401, 'unauthorized', 'Sign in to continue');
    const name = () => (current === alice ? 'Semrush' : 'Yoast');
    fakeApi({
      'GET /api/auth/me': () => (current ? json(200, { user: current }) : unauthorized()),
      'POST /api/auth/login': () => {
        current = bob;
        return json(200, { user: bob });
      },
      'GET /api/clients': () =>
        current ? json(200, { items: [clientOf(name())] }) : unauthorized(),
      'GET /api/pages': () =>
        current
          ? json(200, { items: [pageOf(name())], page: 1, pageSize: 20, total: 1 })
          : unauthorized(),
      'GET /api/pages/p1': () =>
        current ? apiError(404, 'not_found', 'Page not found') : unauthorized(),
    });
    const { router } = renderRoute('/');
    expect(await screen.findByRole('link', { name: 'Semrush post' })).toBeInTheDocument();

    // Alice's session expires; the next request answers 401 and the app asks for a sign-in.
    current = null;
    await router.navigate('/pages/p1');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();

    await signIn('bob@agency.test', 'demo-password');
    expect(await screen.findByText('bob@agency.test')).toBeInTheDocument();
    await router.navigate('/');

    expect(await screen.findByRole('link', { name: 'Yoast post' })).toBeInTheDocument();
    expect(screen.queryByText(/Semrush/)).not.toBeInTheDocument();
  });
});

describe('safeReturnTo', () => {
  it.each([
    [null, '/'],
    ['/pages?q=seo', '/pages?q=seo'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
  ])('%s → %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});
