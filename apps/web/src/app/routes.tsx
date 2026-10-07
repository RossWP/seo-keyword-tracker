import type { RouteObject } from 'react-router';
import { LoginPage } from '../features/auth/login-page';
import { AddClientPage } from '../features/clients/add-client-page';
import { ClientsPage } from '../features/clients/clients-page';
import { RequireAuth } from '../features/auth/require-auth';
import { PageDetailPage } from '../features/pages/page-detail-page';
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
          { path: 'pages/:pageId', element: <PageDetailPage /> },
          { path: 'clients', element: <ClientsPage /> },
          { path: 'clients/new', element: <AddClientPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
