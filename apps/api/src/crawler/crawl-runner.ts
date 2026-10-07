import type { FastifyBaseLogger } from 'fastify';

/**
 * In-process crawl queue: at most `concurrency` crawls at once, each client queued once.
 * The job state itself lives in the database (clients.crawl_status), so this is only a
 * scheduler; a second instance would need a jobs table with leases (README).
 */
export function createCrawlRunner({
  run,
  log,
  concurrency = 2,
}: {
  run: (clientId: string, signal: AbortSignal) => Promise<void>;
  log: FastifyBaseLogger;
  concurrency?: number;
}) {
  const queue: string[] = [];
  const active = new Map<string, Promise<void>>();
  let stopped = false;
  const shutdown = new AbortController();
  let idleWaiters: (() => void)[] = [];

  const pump = () => {
    while (!stopped && active.size < concurrency && queue.length > 0) {
      const clientId = queue.shift();
      if (clientId === undefined) break;
      const job = run(clientId, shutdown.signal)
        .catch((error: unknown) => {
          log.error({ err: error, clientId }, 'crawl job failed');
        })
        .finally(() => {
          active.delete(clientId);
          pump();
        });
      active.set(clientId, job);
    }
    if (active.size === 0 && queue.length === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters = [];
    }
  };

  return {
    enqueue(clientId: string): void {
      if (stopped || active.has(clientId) || queue.includes(clientId)) return;
      queue.push(clientId);
      queueMicrotask(pump);
    },
    /** Resolves once nothing is queued or running; tests await this instead of sleeping. */
    idle(): Promise<void> {
      if (active.size === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    /**
     * Stops taking work and asks running crawls to stop after their current page; they put
     * themselves back to "pending" and resume on the next boot. Queued ones are still pending.
     */
    async drain(): Promise<void> {
      stopped = true;
      queue.length = 0;
      shutdown.abort();
      await Promise.allSettled(active.values());
    },
  };
}

export type CrawlRunner = ReturnType<typeof createCrawlRunner>;
