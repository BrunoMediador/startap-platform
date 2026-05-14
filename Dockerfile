ARG APP=api

# ---------- Stage 1: dependências ----------
FROM node:20-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

# ---------- Stage 2: build TypeScript (packages + app) ----------
FROM deps AS build
ARG APP
RUN npm run build --workspaces --if-present

# ---------- Stage 3: runtime mínimo ----------
FROM node:20-alpine AS runtime
ARG APP
ENV NODE_ENV=production
ENV APP_NAME=${APP}
WORKDIR /app

COPY --from=build /repo/package.json ./
COPY --from=build /repo/node_modules ./node_modules

# Packages compilados
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/packages/db/dist ./packages/db/dist
COPY --from=build /repo/packages/db/package.json ./packages/db/package.json
COPY --from=build /repo/packages/integrations/dist ./packages/integrations/dist
COPY --from=build /repo/packages/integrations/package.json ./packages/integrations/package.json

# App compilado
COPY --from=build /repo/apps/${APP}/dist ./app/dist
COPY --from=build /repo/apps/${APP}/package.json ./app/package.json

CMD ["sh", "-c", "if [ \"$APP_NAME\" = worker ]; then node ./app/dist/worker.js; else node ./app/dist/server.js; fi"]
