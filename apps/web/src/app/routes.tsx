import type { RouteObject } from 'react-router';
import { LoginPage } from '../features/auth/login-page';
import { RequireAuth } from '../features/auth/require-auth';
import { AppLayout } from './app-layout';
import { HomePage } from './home-page';
import { NotFoundPage } from './not-found-page';

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { path: 'login', element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <HomePage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
