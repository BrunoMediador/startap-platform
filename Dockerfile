# Multi-stage build genérico para api/worker.
# Use: docker build --build-arg APP=api -t startap-api .
#      docker build --build-arg APP=worker -t startap-worker .

ARG APP=api

# ---------- Stage 1: dependências ----------
FROM node:20-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

# ---------- Stage 2: build TypeScript ----------
FROM deps AS build
ARG APP
RUN npm -w @startap/${APP} run build

# ---------- Stage 3: runtime mínimo ----------
FROM node:20-alpine AS runtime
ARG APP
ENV NODE_ENV=production
ENV APP_NAME=${APP}
WORKDIR /app

COPY --from=build /repo/package.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/${APP}/dist ./app/dist
COPY --from=build /repo/apps/${APP}/package.json ./app/package.json

# api → dist/server.js | worker → dist/worker.js
CMD ["sh", "-c", "if [ \"$APP_NAME\" = worker ]; then node ./app/dist/worker.js; else node ./app/dist/server.js; fi"]
