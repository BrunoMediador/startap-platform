# ─────────────────────────────────────────────
# Stage 1: builder — compila @startap/core e @startap/integrations
# O contexto de build deve ser a RAIZ do monorepo:
#   docker build -f painel-admin/Dockerfile -t painel-admin .
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /monorepo

# Copia manifests do monorepo (necessário pro npm ci resolver workspaces)
COPY package.json package-lock.json tsconfig.base.json ./

# Copia manifests de cada workspace (para que npm ci instale as deps certas)
COPY packages/core/package.json      packages/core/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/db/package.json        packages/db/package.json
COPY apps/api/package.json           apps/api/package.json
COPY apps/worker/package.json        apps/worker/package.json

# Instala TODAS as deps (incluindo devDeps para o tsc)
RUN npm ci --no-audit --no-fund

# Copia sources dos pacotes que precisam ser compilados.
# @startap/db é dep transitiva: integrations/src/openai/agent.ts importa @startap/db
# (mesmo que o painel só use o cliente gcal, tsc compila o package inteiro).
COPY packages/core/         packages/core/
COPY packages/db/           packages/db/
COPY packages/integrations/ packages/integrations/

# Compila na ordem das dependências: core -> db -> integrations.
RUN npm run build -w @startap/core
RUN npm run build -w @startap/db
RUN npm run build -w @startap/integrations

# ─────────────────────────────────────────────
# Stage 2: runtime — imagem final do painel-admin
# ─────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copia manifests do painel e instala só deps de produção
COPY painel-admin/package.json       ./
COPY painel-admin/package-lock.json  ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copia código e assets do painel
COPY painel-admin/server.js ./
COPY painel-admin/public    ./public

# Copia os dist compilados dos pacotes internos.
# server.js usa import('../packages/integrations/dist/...') com path relativo.
# Estando em WORKDIR /app, "../packages" resolve para /packages (um nível acima de /app).
# Por isso os dists são copiados para /packages/, fora do /app.
COPY --from=builder /monorepo/packages/integrations/dist /packages/integrations/dist
COPY --from=builder /monorepo/packages/core/dist         /packages/core/dist

# client.js (de integrations) faz `import { logger } from '@startap/core/logger'`.
# Node resolve esse import pelo node_modules — então plantamos @startap/core lá
# (package.json + dist), usando o `exports` map do core pra resolver `/logger`.
# pino e zod (deps do core) já estão instalados no node_modules via painel-admin/package.json.
COPY --from=builder /monorepo/packages/core/package.json /app/node_modules/@startap/core/package.json
COPY --from=builder /monorepo/packages/core/dist         /app/node_modules/@startap/core/dist

EXPOSE 3030
CMD ["node", "server.js"]
