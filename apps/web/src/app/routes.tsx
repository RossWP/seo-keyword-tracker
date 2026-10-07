import type { RouteObject } from 'react-router';
import { AppLayout } from './app-layout';
import { HomePage } from './home-page';
import { NotFoundPage } from './not-found-page';

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
