# portal-api — Fastify do Portal do Cliente (porta 3051). Espelha o Dockerfile raiz.
# Build a partir da RAIZ do monorepo:
#   docker build -f apps/portal-api/Dockerfile -t portal-api .

# ---------- Stage 1: dependencias ----------
FROM node:20-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

# ---------- Stage 2: build TypeScript (packages + app) ----------
FROM deps AS build
RUN npm run build --workspaces --if-present

# ---------- Stage 3: runtime minimo ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
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
COPY --from=build /repo/apps/portal-api/dist ./app/dist
COPY --from=build /repo/apps/portal-api/package.json ./app/package.json

EXPOSE 3051

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3051/health || exit 1

CMD ["node", "./app/dist/server.js"]
