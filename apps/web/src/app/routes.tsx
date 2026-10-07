import type { RouteObject } from 'react-router';
import { LoginPage } from '../features/auth/login-page';
import { RequireAuth } from '../features/auth/require-auth';
import { PagesListPage } from '../features/pages/pages-list-page';
import { AppLayout } from './app-layout';
import { NotFoundPage } from './not-found-page';

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { path: 'login', element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <PagesListPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
