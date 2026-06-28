# --- Frontend React/Vite (monorepo pnpm) ---
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# --- deps ---
FROM base AS deps
# Tous les package.json + lockfile : requis pour valider --frozen-lockfile sur le
# workspace ; --filter n'installe QUE les deps du front (pas Baileys/natif côté API).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @app/web --filter @app/shared-types

# --- build: compile shared-types puis build statique Vite ---
FROM deps AS build
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web
ARG VITE_API_BASE_URL=/api
ARG VITE_SOCKET_URL=https://app.localhost
ARG VITE_LIVEKIT_URL=wss://livekit.localhost
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_SOCKET_URL=$VITE_SOCKET_URL \
    VITE_LIVEKIT_URL=$VITE_LIVEKIT_URL
RUN pnpm --filter @app/shared-types build \
 && cd apps/web && pnpm run build

# --- runtime: SPA servie par nginx (fallback try_files) ---
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
