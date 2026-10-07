import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FixtureRoute =
  | { status?: number; type?: string; body: string | Uint8Array; headers?: Record<string, string> }
  | ((request: IncomingMessage, response: ServerResponse) => void);

/** A local HTTP server serving fixed responses by path, for crawler tests without the internet. */
export async function startFixtureServer(routes: Record<string, FixtureRoute>) {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    hits.push(path);
    const route = routes[path];
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
      return;
    }
    if (typeof route === 'function') {
      route(request, response);
      return;
    }
    response
      .writeHead(route.status ?? 200, {
        'content-type': route.type ?? 'text/html',
        ...route.headers,
      })
      .end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
