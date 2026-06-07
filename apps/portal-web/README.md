# portal-web — Portal do Cliente (Next.js 15)

App web do Portal do Cliente (`app.startap.tech`). Mission 009 / ADR 0012.
Design "Cadência + âmbar" (`docs/design/portal-cliente/design-spec-cadencia.md`).

Next.js 15 (App Router, RSC), TypeScript, Tailwind CSS v4, TanStack Query,
output `standalone`. UI pura + proxy de sessão — **nenhuma query SQL aqui**; toda
mutação passa pelo `portal-api` (Fastify, porta 3051).

## Arquitetura

- **Proxy same-origin** (`next.config.ts`): `/auth/*` e `/portal/*` são reescritos
  para o `portal-api`. Mesmo domínio público → sem CORS; o cookie httpOnly de
  sessão (`portal.sid`) viaja sozinho. A internet só enxerga o Next; o `portal-api`
  fica na rede interna (`automacoes_rede_interna`) e nunca é exposto.
- **Auth/guard**: o `portal-api` é dono da sessão (Redis). O Next só consulta
  `/auth/me` server-side (`src/lib/server-auth.ts`) para gatear o grupo `(app)` e
  redirecionar deslogados a `/login`. Logout limpa o cache do React Query.
- **Multi-tenant**: o `slot` vem sempre da sessão no servidor (`withTenant` no
  backend). O front nunca envia `slot`; as query keys carregam o slot da sessão
  para isolar o cache por tenant.

## Rotas

| Rota | Tela |
|---|---|
| `/login` | Login (POST /auth/login) |
| `/inicio` | Home: status do bot, vencimento, métricas, agendamentos |
| `/servicos` | Serviços (lista editável, salvamento otimista) |
| `/horarios` | Grade horária semanal (switch roxo, otimista) |
| `/pausas` | Pausas (dropdown de contatos, confirmação explícita) |

## Variáveis de ambiente

Documentadas aqui — **não commitar `.env`** (gitignored). Só o `portal-web`
precisa de UMA variável própria:

| Var | Default | Descrição |
|---|---|---|
| `PORTAL_API_URL` | `http://localhost:3051` | Destino do proxy/guard para o `portal-api`. Em container: `http://startap-portal-api:3051`. |
| `PORT` | `3050` | Porta do Next (definida no Dockerfile/compose). |
| `NEXT_TELEMETRY_DISABLED` | `1` | Desliga telemetria do Next (definida no Dockerfile). |

> As demais vars (`PORTAL_SESSION_SECRET`, `PG_*`, `REDIS_*`, `WAHA_*`, lockout,
> bcrypt cost) são do **`portal-api`**, não deste app — ver
> `apps/portal-api/src/config.schema.ts`.

## Rodar local

Pré-requisito: o `portal-api` rodando em `localhost:3051` (ou aponte
`PORTAL_API_URL` para onde ele estiver).

```bash
# da raiz do monorepo
npm install
npm run dev --workspace @startap/portal-web      # http://localhost:3050
```

## Build / qualidade

```bash
npm run build --workspace @startap/portal-web    # next build (standalone)
npx biome check apps/portal-web                  # lint/format (limpo)
npx vitest run apps/portal-web                    # unit (billing + format)
```

## Docker

```bash
# build a partir da raiz do monorepo
docker build -f apps/portal-web/Dockerfile -t portal-web .
# ou via compose (sobe portal-web + portal-api + redis)
docker compose up portal-web
```

Container `startap-portal-web`, porta interna 3050, rede
`automacoes_rede_interna`. NPM roteia `app.startap.tech` → `portal-web:3050`.

## Acessibilidade

Foco visível em todo interativo, alvos ≥44px, contraste AA (tokens validados na
spec §8), `role`/`aria-*` em modais/toasts/switches, trap de foco + Esc nos
overlays, `prefers-reduced-motion` desliga pulse/shimmer/transições.
