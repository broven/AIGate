FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
COPY packages/dashboard/package.json packages/dashboard/
RUN bun install

# Build dashboard
FROM deps AS dashboard-build
ARG APP_VERSION=dev
COPY packages/shared packages/shared
COPY packages/dashboard packages/dashboard
COPY tsconfig.json ./
RUN cd packages/dashboard && APP_VERSION=${APP_VERSION} bun run build

# Production
FROM base AS production
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
RUN bun install --production

COPY packages/shared packages/shared
COPY packages/gateway packages/gateway
COPY --from=dashboard-build /app/packages/dashboard/dist packages/gateway/dashboard

ENV HOST=0.0.0.0
ENV PORT=3000
ENV ADMIN_TOKEN=""
EXPOSE 3000

VOLUME /app/packages/gateway/data

WORKDIR /app/packages/gateway
CMD ["bun", "run", "src/index.ts"]
