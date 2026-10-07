# One Dockerfile, two runnable targets: `api` (Node) and `web` (static files behind nginx).
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS pnpm
RUN npm install --global pnpm@12.9.1
WORKDIR /app

# Dependencies change less often than code: install from manifests alone so this layer caches.
FROM pnpm AS deps
COPY --chmod=644 package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chmod=644 apps/api/package.json apps/api/
COPY --chmod=644 apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY --chmod=644 tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/web apps/web
RUN pnpm --filter @tracker/api build && pnpm --filter @tracker/web build

# Production dependencies of the API only: no TypeScript, Vite, test tools or esbuild.
FROM pnpm AS api-deps
COPY --chmod=644 package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chmod=644 apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @tracker/api

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps /app/node_modules ./node_modules
COPY --from=api-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chmod=644 /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
# Readable by the non-root user whatever the builder's umask was.
RUN chmod -R a+rX /app
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
COPY --chmod=644 apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
