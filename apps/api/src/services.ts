import type { Database } from './db/client.js';
import { createAuthService } from './modules/auth/auth.service.js';

export interface ServiceDeps {
  db: Database;
  now: () => Date;
}

export function createServices(deps: ServiceDeps) {
  return {
    auth: createAuthService(deps),
  };
}

export type Services = ReturnType<typeof createServices>;
