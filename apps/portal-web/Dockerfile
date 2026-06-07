# portal-web — Next.js 15 (App Router) do Portal do Cliente. Porta 3050.
# Output standalone (ADR 0012, Decisao 5: economia de RAM no VPS sem swap).
# Build a partir da RAIZ do monorepo (workspaces):
#   docker build -f apps/portal-web/Dockerfile -t portal-web .
#
# O Next so precisa do proprio codigo + suas deps (nao depende de packages/* do
# backend). O build roda no CI/host, nunca no VPS (ADR 0012).

# ---------- Stage 1: dependencias do app ----------
FROM node:20-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY apps/portal-web/package.json ./apps/portal-web/package.json
# Instala apenas a workspace do portal-web (sem puxar packages/* nem outros apps).
RUN npm install --workspace @startap/portal-web --include-workspace-root --no-audit --no-fund

# ---------- Stage 2: build do Next ----------
FROM deps AS build
WORKDIR /repo
COPY apps/portal-web ./apps/portal-web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @startap/portal-web

# ---------- Stage 3: runtime minimo (standalone) ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3050
ENV HOSTNAME=0.0.0.0

# Usuario nao-root (boa pratica; o Next standalone nao precisa de root).
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Artefatos do output standalone: server.js + node_modules minimos + estaticos.
COPY --from=build --chown=nextjs:nodejs /repo/apps/portal-web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/portal-web/.next/static ./apps/portal-web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/portal-web/public ./apps/portal-web/public

USER nextjs
EXPOSE 3050

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3050/ > /dev/null 2>&1 || exit 1

# O standalone gera o server.js dentro de apps/portal-web/ (estrutura do monorepo).
CMD ["node", "apps/portal-web/server.js"]
