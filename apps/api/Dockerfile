# --- Backend NestJS + Baileys (monorepo pnpm) ---
# Base Debian (glibc) : Baileys dépend de libsignal (git + build natif éventuel).
FROM node:22-bookworm-slim AS base
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- deps : git + toolchain pour la dépendance git/native de Baileys ---
FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# Tous les package.json + lockfile : requis pour valider --frozen-lockfile sur le
# workspace ; --filter n'installe QUE les deps de l'API (pas le front).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @app/api --filter @app/shared-types

# --- build : shared-types, client Prisma, build NestJS ---
FROM deps AS build
COPY packages/shared-types packages/shared-types
COPY apps/api apps/api
RUN pnpm --filter @app/shared-types build \
 && cd apps/api && pnpm exec prisma generate && pnpm run build

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
